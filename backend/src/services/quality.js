const { validationFailed } = require("./validation");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreCommercialQuality({ task, context, aiResult, mediaType, index }) {
  const provider = aiResult.provider || "mock";
  const imageModel = aiResult.model_meta?.image_model || aiResult.model_meta?.video_model || "";
  const strategy = task.params?.quality_strategy || "commercial";
  const garmentRisks = context.garment?.risk_flags || [];
  const modelRisks = context.model?.risk_flags || [];
  const effectValidation = aiResult.model_meta?.tryon_effect_validation;
  const effectFailed = validationFailed(effectValidation);
  const retryExhausted = Boolean(aiResult.model_meta?.product_fidelity_retry_exhausted);
  const finalOptimizeRequested = mediaType === "image" && task.params?.post_optimize?.enabled === true;
  const finalOptimizeFailed = finalOptimizeRequested && Boolean(
    aiResult.model_meta?.openai_image_optimizer_error ||
    aiResult.model_meta?.openai_image_optimizer_rejected ||
    (aiResult.model_meta?.openai_image_optimizer_skipped && !aiResult.model_meta?.openai_image_optimizer)
  );
  const riskPenalty = [...garmentRisks, ...modelRisks].reduce(
    (sum, item) => sum + (item.level === "block" ? 22 : item.level === "warn" ? 6 : 2), 0
  );
  let base = mediaType === "video" ? 76 : 78;
  if (provider === "aliyun") base += 8;
  if (/aitryon-plus/i.test(imageModel)) base += 4;
  if (/refiner/i.test(imageModel)) base += 6;
  if (task.params?.pre_edit?.enabled === true && task.params?.pre_edit?.prompt) base += 2;
  if (strategy === "studio") base += 4;
  if (strategy === "preview") base -= 7;
  if (effectFailed || retryExhausted) base -= 38;
  if (finalOptimizeFailed) base -= 22;
  base -= index * 4;
  base -= Math.min(18, riskPenalty);

  const garmentNaturalness = clamp(base + (index === 2 ? -14 : 0), 35, 96);
  const garmentConsistency = clamp(base + (/qwen-image-edit-max|qwen-image-2.0-pro/i.test(task.params?.pre_edit?.model || "") ? 3 : 0) - (index === 3 ? 7 : 0), 35, 96);
  const clarity = clamp(base + (/refiner/i.test(imageModel) ? 5 : -4) + (Number(process.env.ALIYUN_TRYON_RESOLUTION || 1280) >= 1280 ? 2 : -5), 35, 96);
  const bodyIntegrity = clamp(base - (context.model?.pose_type === "half_body" && context.garment?.category === "pants" ? 16 : 0), 35, 96);
  const backgroundQuality = clamp(base + 3, 40, 98);
  const overall = Math.round(
    garmentNaturalness * 0.35 + garmentConsistency * 0.30 + clarity * 0.20 + bodyIntegrity * 0.10 + backgroundQuality * 0.05
  );

  const issueTags = [];
  if (garmentNaturalness < 70) issueTags.push("服装变形风险");
  if (garmentConsistency < 70) issueTags.push("商品一致性不足");
  if (clarity < 70) issueTags.push("清晰度不足");
  if (bodyIntegrity < 70) issueTags.push("人体结构风险");
  if (effectFailed) {
    issueTags.push(effectValidation?.product_fidelity_passed === false ? "商品一致性不合格" : "试衣未明显生效");
    (effectValidation.issue_tags || []).slice(0, 2).forEach(tag => issueTags.push(tag));
  }
  if (retryExhausted) issueTags.push("已达最大重试次数");
  if (finalOptimizeFailed) issueTags.push("最终商用出图未完成");
  garmentRisks.concat(modelRisks).filter(item => item.level === "warn").slice(0, 2).forEach(item => issueTags.push(item.message));

  let qualityStatus = "unusable";
  if (overall >= 80 && garmentNaturalness >= 70 && garmentConsistency >= 70 && clarity >= 70) qualityStatus = "recommended";
  else if (overall >= 70) qualityStatus = "usable";
  else if (overall >= 55) qualityStatus = "repair_needed";
  if (effectFailed || retryExhausted) qualityStatus = "unusable";
  if (finalOptimizeFailed && qualityStatus === "recommended") qualityStatus = "repair_needed";

  return {
    overall_score: overall,
    quality_status: qualityStatus,
    issue_tags: issueTags,
    hd_status: qualityStatus === "recommended" ? "enhanced" : qualityStatus === "usable" ? "ready" : qualityStatus === "repair_needed" ? "needs_repair" : "not_allowed",
    download_allowed: ["recommended", "usable"].includes(qualityStatus),
    report: {
      overall_score: overall,
      garment_naturalness: garmentNaturalness,
      garment_consistency: garmentConsistency,
      clarity,
      body_integrity: bodyIntegrity,
      background_quality: backgroundQuality,
      tryon_effect_passed: effectValidation ? Boolean(effectValidation.passed) : null,
      tryon_effect_reason: effectValidation?.reason || null,
      color_match: effectValidation?.color_match ?? null,
      color_score: effectValidation?.color_score ?? null,
      shape_length_match: effectValidation?.shape_length_match ?? null,
      shape_length_score: effectValidation?.shape_length_score ?? null,
      detail_texture_match: effectValidation?.detail_texture_match ?? null,
      detail_texture_score: effectValidation?.detail_texture_score ?? null,
      product_fidelity_passed: effectValidation?.product_fidelity_passed ?? null,
      product_fidelity_attempts: aiResult.model_meta?.product_fidelity_attempts || 1,
      product_fidelity_max_attempts: aiResult.model_meta?.product_fidelity_max_attempts || (Number(process.env.PRODUCT_FIDELITY_MAX_RETRIES || 3) + 1),
      product_fidelity_max_retries: aiResult.model_meta?.product_fidelity_max_retries || Number(process.env.PRODUCT_FIDELITY_MAX_RETRIES || 3),
      product_fidelity_retry_exhausted: retryExhausted,
      final_commercial_output_failed: finalOptimizeFailed,
      commercial_grade: overall >= 90 ? "S" : overall >= 80 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : "D",
      decision: qualityStatus === "recommended" ? "recommend_for_commerce" : qualityStatus === "usable" ? "allow_basic_download" : qualityStatus === "repair_needed" ? "send_to_repair" : "reject_for_commerce"
    }
  };
}

module.exports = { scoreCommercialQuality, clamp };
