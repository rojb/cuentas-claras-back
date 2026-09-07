-- 002_group_member_leaving.sql
--
-- Leaving a group.
--
-- A membership is NOT deleted when somebody leaves, and it cannot be: the
-- ledger points at it. expenses.paid_by, expense_shares.user_id and both ends
-- of payments carry composite foreign keys into group_members (group_id,
-- user_id). Deleting the row would either be refused by the database or, with
-- a cascade, erase somebody's half of the history — and this ledger does not
-- erase history, it voids. Expenses already work that way (deleted_at), and
-- so does a membership from now on.
--
-- So leaving is a fact with a date on it, exactly like everything else here.

BEGIN;

ALTER TABLE group_members ADD COLUMN left_at timestamptz;

-- Every membership question the app asks is now "who is in this group RIGHT
-- NOW", so the index answers that one and stays out of the way of the rows
-- that only the ledger still cares about.
CREATE INDEX group_members_active_by_user
    ON group_members (user_id)
    WHERE left_at IS NULL;

CREATE INDEX group_members_active_by_group
    ON group_members (group_id)
    WHERE left_at IS NULL;

COMMIT;
