INSERT INTO tenants (id, name, plan, quota_policy)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Demo Fashion Studio', 'pro', '{"image_monthly": 3000, "video_monthly": 500}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, tenant_id, email, name, role, credit_balance)
VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'demo@tryon.local', '运营演示账号', 'owner', 1200)
ON CONFLICT (id) DO NOTHING;

INSERT INTO model_assets (
  id, tenant_id, source, name, gender, age_range, skin_tone, body_type, pose_type, categories, license_info
)
VALUES
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', 'system', 'Eva 欧美全身站姿', 'female', '25-30', 'light', 'slim', 'full_body_standing', '["dress","coat","pants","shirt"]', '{"commercial": true}'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000001', 'system', 'Mia 亚洲棚拍半身', 'female', '22-28', 'medium', 'regular', 'half_body', '["shirt","jacket","sweater"]', '{"commercial": true}'),
  ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000001', 'system', 'Noah 男装慢走展示', 'male', '26-34', 'medium', 'athletic', 'walking', '["coat","pants","shirt"]', '{"commercial": true}')
ON CONFLICT (id) DO NOTHING;
