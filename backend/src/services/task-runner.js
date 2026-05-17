// Task scheduling, execution, and settlement
// Called by: server.js (refactored entry point)
// Depends on: store, garment, validation, quality, model-gateway

const { readStore, writeStore, id, now, addEvent, findModelById } = require("../store/store");
const { normalizeGarmentReferenceImages } = require("./garment");
const { validationFailed, normalizeProviderError } = require("./validation");
const { clamp } = require("./quality");
const { generateTryOnImage, generateTryOnVideo, optimizeImageWithOpenAI, validateTryOnEffectWithVision } = require("../ai/model-gateway");

const STATUS_FLOW_IMAGE = [
  ["pending", 5, "任务已提交，等待队列"],
  ["prechecking", 12, "正在进行生成前质量预检"],
  ["pre_editing", 22, "正在做试衣前素材改图"],
  ["virtual_tryon", 42, "正在虚拟试衣中"],
  ["tryon_refining", 62, "正在进行试衣图精修"],
  ["effect_validating", 76, "正在检查试衣是否生效"],
  ["gpt_image_optimizing", 88, "正在进行最终商用出图"],
  ["quality_scoring", 96, "正在进行商用品质评分"],
  ["completed", 100, "生成完成"]
];

const STATUS_FLOW_VIDEO = [
  ["pending", 4, "任务已提交，等待视频队列"],
  ["prechecking", 14, "正在进行生成前质量预检"],
  ["generating_keyframes", 32, "正在生成试穿关键帧"],
  ["rendering_video", 68, "正在生成试穿视频"],
  ["frame_checking", 82, "正在检查帧一致性"],
  ["encoding", 93, "正在编码导出 MP4"],
  ["completed", 100, "生成完成"]
];

function updateTaskStage(store, task, status, progress, message) {
  task.status = status;
  task.progress = progress;
  task.current_stage = status;
  task.message = message;
  task.updated_at = now();
  task.stage_timings[status] = task.updated_at;
  addEvent(store, task.id, status, progress, message);
  writeStore(store);
}

async function createImageCandidate(store, task, index, context, imageCount, baseProgress, attempt, maxAttempts) {
  task.stage_timings[`candidate_${index}_attempt_${attempt}`] = {
    started_at: now(),
    max_attempts: maxAttempts
  };
  const selectedTryonModel = String(task.params?.image?.tryon_model || "").toLowerCase();
  const isGptImageTryon = selectedTryonModel === "gpt-image:try-on" || selectedTryonModel === "gpt-image:tryon" || selectedTryonModel === "gpt-image";
  if (!isGptImageTryon && task.params?.pre_edit?.enabled !== false) {
    updateTaskStage(store, task, "pre_editing", clamp(Math.max(20, baseProgress), 1, 98), `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在做试衣前素材改图`);
  }
  updateTaskStage(store, task, "virtual_tryon", clamp(Math.max(36, baseProgress + 8), 1, 98), `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在虚拟试衣中`);
  let aiResult = await generateTryOnImage(task, context, index);
  let effectValidation = aiResult.model_meta?.tryon_effect_validation || null;
  try {
    if (!effectValidation) {
      updateTaskStage(store, task, "effect_validating", task.active_progress.validate, `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在检查商品一致性`);
      effectValidation = await validateTryOnEffectWithVision({ task, context, aiResult });
    }
    if (effectValidation && !aiResult.model_meta?.tryon_effect_validation) {
      aiResult = {
        ...aiResult,
        model_meta: {
          ...(aiResult.model_meta || {}),
          tryon_effect_validator: effectValidation.model,
          tryon_effect_validation: effectValidation
        }
      };
    }
    if (effectValidation) task.stage_timings[`tryon_effect_validate_${index}_attempt_${attempt}`] = effectValidation;
  } catch (error) {
    task.stage_timings[`tryon_effect_validate_${index}_attempt_${attempt}_error`] = {
      error: error?.message || String(error),
      at: now()
    };
  }

  if (validationFailed(effectValidation)) {
    task.stage_timings[`downstream_models_${index}_attempt_${attempt}_cancelled`] = {
      reason: "product_fidelity_or_tryon_effect_failed",
      cancelled: ["tryon_refiner", "final_commercial_retouch"],
      validation: effectValidation,
      at: now()
    };
    return {
      ...aiResult,
      model_meta: {
        ...(aiResult.model_meta || {}),
        openai_image_optimizer_skipped: true,
        openai_image_optimizer_skip_reason: "商品一致性或试衣生效质检未通过，后续大模型环节已取消。"
      }
    };
  }

  try {
    const tryOnPassedResult = {
      ...aiResult,
      model_meta: {
        ...(aiResult.model_meta || {}),
        tryon_effect_validator: effectValidation?.model || aiResult.model_meta?.tryon_effect_validator,
        tryon_effect_validation: effectValidation || aiResult.model_meta?.tryon_effect_validation
      }
    };
    aiResult = await optimizeImageWithOpenAI(task, context, aiResult, index);
    updateTaskStage(store, task, "effect_validating", task.active_progress.validate, `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在复核最终商品一致性`);
    const finalValidation = await validateTryOnEffectWithVision({ task, context, aiResult });
    if (finalValidation) {
      task.stage_timings[`final_product_fidelity_validate_${index}_attempt_${attempt}`] = finalValidation;
      if (validationFailed(finalValidation)) {
        task.stage_timings[`final_commercial_output_${index}_attempt_${attempt}_rejected`] = {
          reason: finalValidation.reason || "最终商用出图改变了目标服装",
          issue_tags: finalValidation.issue_tags || [],
          rejected_image_url: aiResult.image_url || aiResult.cover_url,
          fallback_image_url: tryOnPassedResult.image_url || tryOnPassedResult.cover_url,
          at: now()
        };
        return {
          ...tryOnPassedResult,
          model_meta: {
            ...(tryOnPassedResult.model_meta || {}),
            final_product_fidelity_validation: finalValidation,
            openai_image_optimizer_rejected: true,
            openai_image_optimizer_rejected_reason: finalValidation.reason || "最终商用出图改变了目标服装，已自动回退到试衣精修图。",
            openai_image_optimizer_rejected_issue_tags: finalValidation.issue_tags || [],
            openai_image_optimizer_fallback_url: tryOnPassedResult.image_url || tryOnPassedResult.cover_url
          }
        };
      }
      aiResult = {
        ...aiResult,
        model_meta: {
          ...(aiResult.model_meta || {}),
          tryon_effect_validator: finalValidation.model,
          tryon_effect_validation: finalValidation,
          final_product_fidelity_validation: finalValidation
        }
      };
    }
  } catch (error) {
    task.stage_timings[`openai_image_optimize_${index}_attempt_${attempt}_error`] = {
      error: error?.message || String(error),
      at: now()
    };
    aiResult = {
      ...aiResult,
      model_meta: {
        ...(aiResult.model_meta || {}),
        openai_image_optimizer_skipped: true,
        openai_image_optimizer_error: error?.message || String(error)
      }
    };
  }
  return aiResult;
}

async function createResult(store, task, mediaType, index, context) {
  const { scoreCommercialQuality } = require("./quality");
  const imageCount = Math.max(1, Number(task.params?.image?.count || 1));
  const baseProgress = Math.min(92, 18 + Math.round((index / imageCount) * 68));
  Object.defineProperties(task, {
    active_generation_index: { value: index, writable: true, configurable: true, enumerable: false },
    active_generation_count: { value: imageCount, writable: true, configurable: true, enumerable: false },
    active_progress: {
      value: {
        preEdit: clamp(Math.max(20, baseProgress), 1, 98),
        tryon: clamp(Math.max(36, baseProgress + 8), 1, 98),
        refine: clamp(Math.max(58, baseProgress + 18), 1, 98),
        validate: clamp(Math.max(72, baseProgress + 28), 1, 98),
        gpt: clamp(Math.max(84, baseProgress + 36), 1, 98),
        score: clamp(Math.max(92, baseProgress + 42), 1, 98)
      },
      writable: true,
      configurable: true,
      enumerable: false
    },
    reportStage: { value: (status, progress, message) => updateTaskStage(store, task, status, progress, message), writable: true, configurable: true, enumerable: false }
  });
  let aiResult;
  if (mediaType === "image") {
    const maxRetries = Math.max(0, Number(process.env.PRODUCT_FIDELITY_MAX_RETRIES || 3));
    const maxAttempts = maxRetries + 1;
    let lastCandidate = null;
    let lastValidation = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        aiResult = await createImageCandidate(store, task, index, context, imageCount, baseProgress, attempt, maxAttempts);
        lastCandidate = aiResult;
      } catch (error) {
        task.stage_timings[`candidate_${index}_attempt_${attempt}_error`] = {
          error: error?.message || String(error),
          at: now()
        };
        if (!lastCandidate) throw error;
        aiResult = {
          ...lastCandidate,
          model_meta: {
            ...(lastCandidate.model_meta || {}),
            product_fidelity_attempts: attempt - 1,
            product_fidelity_max_attempts: maxAttempts,
            product_fidelity_max_retries: maxRetries,
            product_fidelity_retry_exhausted: true,
            product_fidelity_provider_error_after_candidate: error?.message || String(error),
            product_fidelity_retry_reason: `后续自动重试调用失败，已保留上一张候选图：${lastValidation?.reason || "商品一致性未通过"}`
          }
        };
        break;
      }
      const validation = aiResult.model_meta?.tryon_effect_validation;
      lastValidation = validation || lastValidation;
      if (!validationFailed(validation)) {
        aiResult.model_meta = {
          ...(aiResult.model_meta || {}),
          product_fidelity_attempts: attempt,
          product_fidelity_max_attempts: maxAttempts,
          product_fidelity_max_retries: maxRetries
        };
        break;
      }
      task.stage_timings[`product_fidelity_retry_${index}_${attempt}`] = {
        reason: validation?.reason || "商品一致性未通过",
        issue_tags: validation?.issue_tags || [],
        at: now()
      };
      if (attempt < maxAttempts) {
        task.active_retry_feedback = [
          validation?.reason || "",
          ...(validation?.issue_tags || [])
        ].filter(Boolean).join("；") || "颜色、衣长比例或纹理细节与原图不一致";
        updateTaskStage(store, task, "virtual_tryon", clamp(Math.max(36, baseProgress + 8), 1, 98), `第 ${index + 1}/${imageCount} 张商品一致性未通过，正在自动重试 ${attempt + 1}/${maxAttempts}`);
      } else {
        aiResult.model_meta = {
          ...(aiResult.model_meta || {}),
          product_fidelity_attempts: attempt,
          product_fidelity_max_attempts: maxAttempts,
          product_fidelity_max_retries: maxRetries,
          product_fidelity_retry_exhausted: true,
          product_fidelity_retry_reason: `已自动重新生成 ${maxRetries} 次仍未通过：${validation?.reason || "颜色、版型比例/衣长或装饰纹理与原图不一致"}`
        };
      }
    }
    task.active_retry_feedback = null;
    updateTaskStage(store, task, "quality_scoring", task.active_progress.score, `第 ${index + 1}/${imageCount} 张：正在进行商用品质评分`);
  } else {
    aiResult = await generateTryOnVideo(task, context, index);
  }
  const quality = scoreCommercialQuality({ task, context, aiResult, mediaType, index });
  const result = {
    id: id("result"),
    task_id: task.id,
    media_type: mediaType,
    image_url: mediaType === "image" ? aiResult.image_url : null,
    video_url: mediaType === "video" ? aiResult.video_url : null,
    cover_url: aiResult.cover_url || `/v1/media/results/${task.id}/${index}.svg?cover=1`,
    duration_seconds: mediaType === "video" ? Number(aiResult.duration_seconds || task.params?.video?.duration_seconds || 15) : null,
    score: quality.overall_score,
    quality_status: quality.quality_status,
    issue_tags: quality.issue_tags,
    quality_report: quality.report,
    hd_status: quality.hd_status,
    download_allowed: quality.download_allowed,
    model_meta: {
      ...(aiResult.model_meta || {}),
      provider: aiResult.provider || "mock",
      qc_model: "commercial-quality-rule-v1.0.1",
      quality_strategy: task.params?.quality_strategy || "commercial"
    },
    created_at: now()
  };
  store.results.push(result);
  return result;
}

async function settleTask(taskId) {
  const store = readStore();
  const task = store.tasks.find(item => item.id === taskId);
  if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;

  const imageCount = task.output_type === "image" || task.output_type === "image_video" ? Number(task.params?.image?.count || 4) : 0;
  const hasVideo = task.output_type === "video" || task.output_type === "image_video";
  const garmentReferenceImages = normalizeGarmentReferenceImages(task.params?.garment_references);
  const garment = store.garments.find(item => item.id === task.garment_id);
  const context = {
    garment: garment ? { ...garment, reference_images: garmentReferenceImages } : garment,
    garmentReferences: garmentReferenceImages,
    model: findModelById(store, task.model_id),
    bestImageUrl: null
  };
  for (let i = 0; i < imageCount; i += 1) {
    const result = await createResult(store, task, "image", i, context);
    if (i === 0) context.bestImageUrl = result.image_url;
  }
  if (hasVideo) await createResult(store, task, "video", imageCount, context);

  const taskResults = store.results.filter(result => result.task_id === task.id);
  const recommended = taskResults.filter(result => result.quality_status === "recommended");
  const usable = taskResults.filter(result => result.quality_status === "usable");
  const repairNeeded = taskResults.filter(result => result.quality_status === "repair_needed");
  const unusable = taskResults.filter(result => result.quality_status === "unusable");
  const commercialPassed = recommended.length >= 1;

  task.status = "completed";
  task.progress = 100;
  task.current_stage = "completed";
  task.commercial_status = commercialPassed ? "passed" : "not_passed";
  task.quality_summary = {
    commercial_passed: commercialPassed,
    recommended_count: recommended.length,
    usable_count: usable.length,
    repair_needed_count: repairNeeded.length,
    unusable_count: unusable.length,
    best_score: taskResults.reduce((max, result) => Math.max(max, Number(result.score || 0)), 0)
  };
  task.message = commercialPassed ? "生成完成，已筛出可商用推荐图" : "生成完成，但未达到商用推荐门槛，建议更换素材或切换商拍增强";
  task.completed_at = now();
  task.stage_timings.completed_at = task.completed_at;
  addEvent(store, task.id, task.status, task.progress, task.message);

  const log = store.credit_logs.find(item => item.task_id === task.id && item.reason === "precharge");
  if (log) log.status = "settled";
  writeStore(store);
}

function scheduleTask(taskId) {
  const store = readStore();
  const task = store.tasks.find(item => item.id === taskId);
  if (!task) return;
  const flow = task.output_type === "video" ? STATUS_FLOW_VIDEO : task.output_type === "image_video" ? STATUS_FLOW_VIDEO : STATUS_FLOW_IMAGE;
  flow.forEach(([status, progress, message], index) => {
    setTimeout(() => {
      if (status === "completed") {
        settleTask(taskId).catch(error => {
          const current = readStore();
          const item = current.tasks.find(row => row.id === taskId);
          if (!item) return;
          const normalized = normalizeProviderError(error);
          item.status = "failed";
          item.progress = 100;
          item.current_stage = "failed";
          item.failure_reason = normalized.providerMessage;
          item.failure_detail = normalized;
          item.message = normalized.userMessage;
          addEvent(current, taskId, item.status, item.progress, `${normalized.userMessage} ${normalized.suggestion}`);
          writeStore(current);
        });
        return;
      }
      const current = readStore();
      const item = current.tasks.find(row => row.id === taskId);
      if (!item || item.status === "cancelled") return;
      item.status = status;
      item.progress = progress;
      item.current_stage = status;
      item.message = message;
      item.stage_timings[status] = now();
      addEvent(current, taskId, status, progress, message);
      writeStore(current);
    }, index * 1400 + 300);
  });
}

function svgForResult(taskId, index) {
  const store = readStore();
  const task = store.tasks.find(item => item.id === taskId);
  const garment = store.garments.find(item => item.id === task?.garment_id);
  const colors = ["#2563eb", "#0f766e", "#6d28d9", "#d97706", "#16a34a", "#dc2626"];
  const color = colors[index % colors.length];
  const title = garment?.category_label || "AI 试穿";
  const mediaText = task?.output_type === "video" ? "Video Cover" : "Try-on Result";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#e0f2fe"/>
    </linearGradient>
  </defs>
  <rect width="900" height="1200" fill="url(#bg)"/>
  <rect x="84" y="72" width="732" height="1056" rx="42" fill="#fff" stroke="#e4e7ec" stroke-width="3"/>
  <circle cx="450" cy="230" r="76" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="6"/>
  <path d="M280 1020 C300 700, 340 425, 450 425 C560 425, 600 700, 620 1020 Z" fill="${color}" opacity="0.92"/>
  <path d="M340 500 C380 560, 520 560, 560 500" fill="none" stroke="#fff" stroke-width="14" opacity="0.8"/>
  <path d="M310 680 L590 680 M300 790 L600 790 M315 900 L585 900" stroke="#fff" stroke-width="10" opacity="0.35"/>
  <text x="450" y="1090" text-anchor="middle" fill="#101828" font-size="38" font-family="Arial, sans-serif" font-weight="700">${title}</text>
  <text x="450" y="1140" text-anchor="middle" fill="#667085" font-size="24" font-family="Arial, sans-serif">${mediaText} ${index + 1}</text>
</svg>`;
}

module.exports = {
  STATUS_FLOW_IMAGE,
  STATUS_FLOW_VIDEO,
  updateTaskStage,
  createImageCandidate,
  createResult,
  settleTask,
  scheduleTask,
  svgForResult
};
