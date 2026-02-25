-- Ethernet cable extraction jobs and results
CREATE TABLE IF NOT EXISTS ethernet_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  vessel_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  error_msg TEXT,
  results JSONB,
  file_names TEXT[],
  storage_paths TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ethernet_jobs_user_id ON ethernet_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_ethernet_jobs_status ON ethernet_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ethernet_jobs_created_at ON ethernet_jobs(created_at DESC);

-- RLS: users can read/insert their own jobs
ALTER TABLE ethernet_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ethernet jobs"
  ON ethernet_jobs FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can insert ethernet jobs"
  ON ethernet_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can update own ethernet jobs"
  ON ethernet_jobs FOR UPDATE
  USING (auth.uid() = user_id OR user_id IS NULL);
