-- AI 虚拟人穿衣 SaaS PostgreSQL schema
-- PostgreSQL 14+

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE task_output_type AS ENUM ('image', 'video', 'image_video');
CREATE TYPE task_status AS ENUM (
  'draft',
  'pending',
  'prechecking',
  'preprocessing',
  'generating_image',
  'generating_keyframes',
  'rendering_video',
  'frame_checking',
  'encoding',
  'quality_checking',
  'auto_repairing',
  'hd_enhancing',
  'recommending',
  'completed',
  'partial_failed',
  'failed',
  'cancelled'
);
CREATE TYPE media_type AS ENUM ('image', 'video');
CREATE TYPE quality_status AS ENUM ('recommended', 'usable', 'repair_needed', 'unusable', 'failed');
CREATE TYPE credit_direction AS ENUM ('debit', 'credit');

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(120) NOT NULL,
  plan VARCHAR(40) NOT NULL DEFAULT 'free',
  quota_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(180) UNIQUE,
  name VARCHAR(120) NOT NULL,
  role VARCHAR(40) NOT NULL DEFAULT 'operator',
  credit_balance INTEGER NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE garment_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_url TEXT,
  preview_url TEXT,
  file_name VARCHAR(255),
  mime_type VARCHAR(80),
  size_bytes BIGINT,
  category VARCHAR(60),
  category_label VARCHAR(80),
  color VARCHAR(80),
  material VARCHAR(80),
  pattern VARCHAR(80),
  length VARCHAR(60),
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'system',
  name VARCHAR(120) NOT NULL,
  file_url TEXT,
  preview_url TEXT,
  gender VARCHAR(40),
  age_range VARCHAR(40),
  skin_tone VARCHAR(40),
  body_type VARCHAR(60),
  pose_type VARCHAR(80),
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  video_enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  license_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE model_library_changes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_id VARCHAR(120) NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model_id)
);

CREATE TABLE tryon_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garment_id UUID REFERENCES garment_assets(id) ON DELETE SET NULL,
  model_id UUID REFERENCES model_assets(id) ON DELETE SET NULL,
  output_type task_output_type NOT NULL DEFAULT 'image',
  prompt TEXT NOT NULL DEFAULT '',
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status task_status NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  current_stage VARCHAR(80),
  message TEXT,
  credit_cost INTEGER NOT NULL DEFAULT 0 CHECK (credit_cost >= 0),
  failure_reason TEXT,
  stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE tryon_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tryon_tasks(id) ON DELETE CASCADE,
  media_type media_type NOT NULL,
  image_url TEXT,
  video_url TEXT,
  cover_url TEXT,
  duration_seconds INTEGER,
  score NUMERIC(4, 2) NOT NULL DEFAULT 0,
  quality_status quality_status NOT NULL DEFAULT 'usable',
  issue_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tryon_tasks(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  direction credit_direction NOT NULL,
  reason VARCHAR(80) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE task_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tryon_tasks(id) ON DELETE CASCADE,
  status task_status NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_garment_assets_tenant_user ON garment_assets(tenant_id, user_id, created_at DESC);
CREATE INDEX idx_model_assets_tenant_source ON model_assets(tenant_id, source);
CREATE INDEX idx_tryon_tasks_tenant_user_created ON tryon_tasks(tenant_id, user_id, created_at DESC);
CREATE INDEX idx_tryon_tasks_status_created ON tryon_tasks(status, created_at);
CREATE INDEX idx_tryon_results_task ON tryon_results(task_id);
CREATE INDEX idx_credit_logs_user_created ON credit_logs(user_id, created_at DESC);
CREATE INDEX idx_task_events_task_created ON task_events(task_id, created_at);

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_touch_updated_at
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_users_touch_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_tryon_tasks_touch_updated_at
BEFORE UPDATE ON tryon_tasks
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_model_assets_touch_updated_at
BEFORE UPDATE ON model_assets
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_model_library_changes_touch_updated_at
BEFORE UPDATE ON model_library_changes
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
