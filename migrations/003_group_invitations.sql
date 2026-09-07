-- 003_group_invitations.sql
--
-- Joining a group is now something you agree to.
--
-- Until this migration, adding somebody to a group put a row in
-- group_members and that was that: the other person found out by opening the
-- app and discovering they were already in. An invitation makes it two
-- sided — one person offers, the other answers.
--
-- WHY A SEPARATE TABLE, and not a status column on group_members:
--
-- group_members (group_id, user_id) is what expenses.paid_by, expense_shares
-- and both ends of payments point at. A row in there does not mean "this
-- person is associated with this group", it means THIS PERSON CAN BE CHARGED
-- MONEY. Parking a pending invitation in that table would let the database
-- happily accept an expense charged to somebody who has not accepted yet, and
-- the only thing standing in the way would be application code remembering to
-- check a status column every single time. That is exactly the kind of hole
-- 002 had to be careful about with left_at.
--
-- Kept apart, each table means one thing: group_members is membership,
-- group_invitations is a question waiting for an answer.

BEGIN;

CREATE TABLE group_invitations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     uuid        NOT NULL REFERENCES expense_groups (id) ON DELETE CASCADE,

    -- Only registered people can be invited, so this is a real user id and
    -- not an email. An invitation to somebody without an account is a
    -- different feature: it would need a nullable user, an email column, and
    -- a rule for what happens when that email finally signs up.
    invited_user uuid        NOT NULL REFERENCES users (id),
    invited_by   uuid        NOT NULL REFERENCES users (id),

    created_at   timestamptz NOT NULL DEFAULT now(),

    status       text        NOT NULL DEFAULT 'pending',
    responded_at timestamptz,

    CONSTRAINT group_invitations_status_is_known
        CHECK (status IN ('pending', 'accepted', 'rejected')),

    -- An answer has a date, and a question does not. Without this the two
    -- columns could drift apart and no query would be able to tell which one
    -- was telling the truth.
    CONSTRAINT group_invitations_answered_has_a_date
        CHECK (
            (status = 'pending'  AND responded_at IS NULL) OR
            (status <> 'pending' AND responded_at IS NOT NULL)
        ),

    -- Inviting yourself is not a thing.
    CONSTRAINT group_invitations_not_to_self
        CHECK (invited_user <> invited_by)
);

-- At most ONE open question per person per group. Answered invitations are
-- left alone on purpose: they are the history of who was asked and what they
-- said, and somebody who declined can be asked again later.
CREATE UNIQUE INDEX group_invitations_one_pending
    ON group_invitations (group_id, invited_user)
    WHERE status = 'pending';

-- "What am I being asked to join?" — the query behind the invitations screen.
CREATE INDEX group_invitations_pending_by_user
    ON group_invitations (invited_user)
    WHERE status = 'pending';

COMMIT;
