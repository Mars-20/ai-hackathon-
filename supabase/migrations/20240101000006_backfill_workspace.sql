-- Backfill personal workspaces for NULL workspace_id, then verify zero NULLs (NOT NULL deferred to Task 8 after verification).
-- NOTE: filename uses 0006 prefix because 0003/0004/0005 are already taken; plan text named 0003 which collides.

-- Create a personal workspace per orphaned owner where one does not already exist.
-- Assumes startups.owner_id references auth.users(id); adapts to workspaces(owner_id, slug) shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'startups'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'workspaces'
  ) THEN
    INSERT INTO workspaces (name, slug, owner_id)
    SELECT 'Personal', 'personal-' || s.owner_id::text, s.owner_id
    FROM startups s
    WHERE s.workspace_id IS NULL
      AND s.owner_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = s.owner_id)
    GROUP BY s.owner_id
    ON CONFLICT DO NOTHING;

    UPDATE startups s
    SET workspace_id = w.id
    FROM workspaces w
    WHERE s.workspace_id IS NULL
      AND w.owner_id = s.owner_id;
  END IF;
END
$$;

-- SELECT count(*) FROM startups WHERE workspace_id IS NULL; -- must be 0 before SET NOT NULL (Task 8).
