-- ═══════════════════════════════════════════════════════════════════════════
-- Validation Copilot — Multi-User Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════════════

-- Enable UUID extension (usually already enabled)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- WORKSPACES
-- Root entity for multi-tenancy. Every data object belongs to a workspace.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  owner_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan         TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- WORKSPACE MEMBERS
-- Many-to-many: users ↔ workspaces with role-based access control
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_members (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)  -- one role per user per workspace
);

-- ─────────────────────────────────────────────────────────────────────────────
-- WORKSPACE INVITES
-- Invite links sent to email addresses (may or may not have existing accounts)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_invites (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  token          UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  expires_at     TIMESTAMPTZ NOT NULL,
  invited_by     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- STARTUPS
-- Workspace-scoped. All validation data hangs off startups.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS startups (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  one_liner        TEXT NOT NULL,
  domain           TEXT NOT NULL,
  target_customer  TEXT,
  stage            TEXT NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea', 'prototype', 'live', 'scaling')),
  business_model   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ASSUMPTIONS
-- Riskiest bets — output of the assumption-mapping skill
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assumptions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  startup_id   UUID NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  statement    TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('desirability', 'viability', 'feasibility')),
  risk_level   TEXT NOT NULL CHECK (risk_level IN ('critical', 'high', 'medium', 'low')),
  status       TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'testing', 'validated', 'invalidated')),
  reasoning    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- EVIDENCE
-- Grounded evidence items — output of market-research + response-analyzer skills
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evidence (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  startup_id      UUID NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assumption_id   UUID REFERENCES assumptions(id) ON DELETE SET NULL,
  evidence_type   TEXT NOT NULL CHECK (evidence_type IN ('secondary', 'primary')),
  source_type     TEXT CHECK (source_type IN ('web_search', 'interview', 'survey', 'preorder', 'usage_data')),
  source_url      TEXT,
  claim           TEXT NOT NULL,
  strength        TEXT NOT NULL CHECK (strength IN ('opinion', 'intent', 'time_given', 'contact_shared', 'commitment')),
  sample_size     INT,
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- EXPERIMENTS
-- Designed validation runs — output of experiment-designer + survey-designer skills
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS experiments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  startup_id     UUID NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assumption_id  UUID REFERENCES assumptions(id) ON DELETE SET NULL,
  type           TEXT NOT NULL CHECK (type IN ('interview', 'survey', 'landing_page', 'presale')),
  design         JSONB NOT NULL DEFAULT '{}',  -- ExperimentDesign JSON
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'running', 'completed')),
  approved_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DECISIONS
-- Final memos — output of the decision-memo skill
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decisions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  startup_id      UUID NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  verdict         TEXT NOT NULL CHECK (verdict IN ('go', 'iterate', 'stop', 'test_more')),
  confidence      TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  rationale       TEXT NOT NULL,
  evidence_ids    UUID[] NOT NULL DEFAULT '{}',
  sample_size     INT,
  response_rate   FLOAT,
  next_experiment TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS) — The core of multi-user data isolation
-- Every user can ONLY see data that belongs to workspaces they are a member of
-- ═══════════════════════════════════════════════════════════════════════════

-- Enable RLS on all tables
ALTER TABLE workspaces          ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invites   ENABLE ROW LEVEL SECURITY;
ALTER TABLE startups            ENABLE ROW LEVEL SECURITY;
ALTER TABLE assumptions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence            ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions           ENABLE ROW LEVEL SECURITY;

-- ─── Helper function: is the current user a member of a workspace? ─────────
CREATE OR REPLACE FUNCTION is_workspace_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = auth.uid()
  );
END;
$$;

-- ─── Helper function: get current user's role in a workspace ──────────────
CREATE OR REPLACE FUNCTION workspace_role(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role
  FROM workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = auth.uid();
  RETURN v_role;
END;
$$;

-- ─── WORKSPACES policies ──────────────────────────────────────────────────
CREATE POLICY "workspaces_select" ON workspaces
  FOR SELECT USING (is_workspace_member(id));

CREATE POLICY "workspaces_insert" ON workspaces
  FOR INSERT WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "workspaces_update" ON workspaces
  FOR UPDATE USING (workspace_role(id) IN ('owner', 'admin'));

CREATE POLICY "workspaces_delete" ON workspaces
  FOR DELETE USING (workspace_role(id) = 'owner');

-- ─── WORKSPACE_MEMBERS policies ───────────────────────────────────────────
CREATE POLICY "members_select" ON workspace_members
  FOR SELECT USING (is_workspace_member(workspace_id));

CREATE POLICY "members_insert" ON workspace_members
  FOR INSERT WITH CHECK (workspace_role(workspace_id) IN ('owner', 'admin'));

CREATE POLICY "members_delete" ON workspace_members
  FOR DELETE USING (workspace_role(workspace_id) = 'owner' OR user_id = auth.uid());

-- ─── WORKSPACE_INVITES policies ───────────────────────────────────────────
CREATE POLICY "invites_select" ON workspace_invites
  FOR SELECT USING (is_workspace_member(workspace_id) OR email = auth.email());

CREATE POLICY "invites_insert" ON workspace_invites
  FOR INSERT WITH CHECK (workspace_role(workspace_id) IN ('owner', 'admin'));

-- ─── STARTUPS policies (member role or above) ─────────────────────────────
CREATE POLICY "startups_select" ON startups
  FOR SELECT USING (is_workspace_member(workspace_id));

CREATE POLICY "startups_insert" ON startups
  FOR INSERT WITH CHECK (
    workspace_role(workspace_id) IN ('owner', 'admin', 'member')
    AND auth.uid() = owner_id
  );

CREATE POLICY "startups_update" ON startups
  FOR UPDATE USING (workspace_role(workspace_id) IN ('owner', 'admin', 'member'));

CREATE POLICY "startups_delete" ON startups
  FOR DELETE USING (workspace_role(workspace_id) IN ('owner', 'admin'));

-- ─── ASSUMPTIONS, EVIDENCE, EXPERIMENTS, DECISIONS — same member-scoped logic
CREATE POLICY "assumptions_select"   ON assumptions   FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "assumptions_insert"   ON assumptions   FOR INSERT WITH CHECK (workspace_role(workspace_id) IN ('owner','admin','member'));
CREATE POLICY "assumptions_update"   ON assumptions   FOR UPDATE USING (workspace_role(workspace_id) IN ('owner','admin','member'));

CREATE POLICY "evidence_select"      ON evidence      FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "evidence_insert"      ON evidence      FOR INSERT WITH CHECK (workspace_role(workspace_id) IN ('owner','admin','member'));

CREATE POLICY "experiments_select"   ON experiments   FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "experiments_insert"   ON experiments   FOR INSERT WITH CHECK (workspace_role(workspace_id) IN ('owner','admin','member'));
CREATE POLICY "experiments_update"   ON experiments   FOR UPDATE USING (workspace_role(workspace_id) IN ('owner','admin'));

CREATE POLICY "decisions_select"     ON decisions     FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "decisions_insert"     ON decisions     FOR INSERT WITH CHECK (workspace_role(workspace_id) IN ('owner','admin','member'));

-- ═══════════════════════════════════════════════════════════════════════════
-- INDEXES — performance on common query patterns
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id    ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace  ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_startups_workspace_id        ON startups(workspace_id);
CREATE INDEX IF NOT EXISTS idx_assumptions_startup_id       ON assumptions(startup_id);
CREATE INDEX IF NOT EXISTS idx_evidence_startup_id          ON evidence(startup_id);
CREATE INDEX IF NOT EXISTS idx_experiments_startup_id       ON experiments(startup_id);
CREATE INDEX IF NOT EXISTS idx_decisions_startup_id         ON decisions(startup_id);
CREATE INDEX IF NOT EXISTS idx_invites_token                ON workspace_invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_email                ON workspace_invites(email);

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIGGER: auto-update updated_at timestamps
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_startups_updated_at
  BEFORE UPDATE ON startups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIGGER: auto-create workspace when user signs up (optional — can also
-- be done in the OAuth callback route)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_workspace_id UUID;
  v_slug TEXT;
BEGIN
  -- Create a personal workspace for the new user
  v_slug := LOWER(COALESCE(
    NEW.raw_user_meta_data->>'full_name',
    SPLIT_PART(NEW.email, '@', 1)
  )) || '-' || FLOOR(EXTRACT(EPOCH FROM NOW()))::TEXT;
  v_slug := REGEXP_REPLACE(v_slug, '[^a-z0-9-]', '-', 'g');

  INSERT INTO workspaces (name, slug, owner_id, plan)
  VALUES (
    COALESCE(NEW.raw_user_meta_data->>'full_name', SPLIT_PART(NEW.email, '@', 1)) || '''s Workspace',
    v_slug,
    NEW.id,
    'free'
  )
  RETURNING id INTO v_workspace_id;

  -- Add user as owner of their new workspace
  INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
  VALUES (v_workspace_id, NEW.id, 'owner', NOW());

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
