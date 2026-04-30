-- Map PAT subject (JWT-style user id string) to users row for quota policy sync
ALTER TABLE users ADD COLUMN IF NOT EXISTS pat_subject VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pat_subject_unique
  ON users(pat_subject)
  WHERE pat_subject IS NOT NULL;
