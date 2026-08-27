-- 001_initial_schema.sql
--
-- The ledger. Two things are ever recorded as facts: expenses and payments.
-- Balances are never stored, because a balance is not a fact — it is a
-- result, and it changes on its own every time a new expense lands.
--
-- Money is always an integer number of cents, exactly like in the domain.
-- No NUMERIC, no floating point, no decimals anywhere near an amount.

BEGIN;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text        NOT NULL,
    password_hash text        NOT NULL,
    display_name  text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_display_name_not_blank CHECK (btrim(display_name) <> ''),
    CONSTRAINT users_email_not_blank        CHECK (btrim(email) <> '')
);

-- Emails are compared case-insensitively: Ana@mail.com is Ana.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------

-- Not called "groups": GROUP is an SQL keyword and quoting it forever is a
-- tax you pay on every single query.
CREATE TABLE expense_groups (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text        NOT NULL,
    currency_code char(3)     NOT NULL,
    created_by    uuid        NOT NULL REFERENCES users (id),
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT expense_groups_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT expense_groups_currency_is_iso CHECK (currency_code ~ '^[A-Z]{3}$')
);

CREATE TABLE group_members (
    group_id  uuid        NOT NULL REFERENCES expense_groups (id) ON DELETE CASCADE,
    user_id   uuid        NOT NULL REFERENCES users (id),
    joined_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_by_user ON group_members (user_id);

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

CREATE TABLE expenses (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id       uuid        NOT NULL REFERENCES expense_groups (id),
    description    text        NOT NULL,
    total_cents    bigint      NOT NULL,
    paid_by        uuid        NOT NULL,

    -- How the user asked for it to be divided, kept for editing and audit.
    -- It is NOT the source of truth for who owes what: expense_shares is.
    split_strategy text        NOT NULL,
    split_params   jsonb       NOT NULL DEFAULT '{}'::jsonb,

    spent_at       timestamptz NOT NULL DEFAULT now(),
    created_by     uuid        NOT NULL REFERENCES users (id),
    created_at     timestamptz NOT NULL DEFAULT now(),

    -- A ledger does not erase history. Deleting is voiding.
    deleted_at     timestamptz,

    CONSTRAINT expenses_total_is_positive     CHECK (total_cents > 0),
    CONSTRAINT expenses_description_not_blank CHECK (btrim(description) <> ''),
    CONSTRAINT expenses_strategy_is_known     CHECK (split_strategy IN (
        'equally', 'exact_amounts', 'percentages', 'shares', 'mixed', 'items'
    )),

    -- You cannot pay for a group you do not belong to.
    CONSTRAINT expenses_payer_belongs_to_group
        FOREIGN KEY (group_id, paid_by) REFERENCES group_members (group_id, user_id),

    -- Redundant as uniqueness (id is already the key), but required so that
    -- child tables can carry group_id and point back at BOTH columns.
    CONSTRAINT expenses_id_group_unique UNIQUE (id, group_id)
);

CREATE INDEX expenses_by_group ON expenses (group_id) WHERE deleted_at IS NULL;

-- What each person actually owes for an expense, already resolved into cents
-- by the domain. Stored, never recomputed: if a rounding rule changes next
-- year, past expenses must not silently change how much people owed.
CREATE TABLE expense_shares (
    expense_id  uuid   NOT NULL,
    group_id    uuid   NOT NULL,
    user_id     uuid   NOT NULL,
    share_cents bigint NOT NULL,

    PRIMARY KEY (expense_id, user_id),

    CONSTRAINT expense_shares_not_negative CHECK (share_cents >= 0),

    CONSTRAINT expense_shares_belong_to_expense
        FOREIGN KEY (expense_id, group_id)
        REFERENCES expenses (id, group_id) ON DELETE CASCADE,

    -- Carrying group_id is what makes this possible: you cannot charge
    -- somebody who is not a member of the group.
    CONSTRAINT expense_shares_user_belongs_to_group
        FOREIGN KEY (group_id, user_id) REFERENCES group_members (group_id, user_id)
);

CREATE INDEX expense_shares_by_user ON expense_shares (group_id, user_id);

-- ---------------------------------------------------------------------------
-- Itemised expenses (burger -> Juan, pizza -> Juan + Ana, tip -> everyone)
-- ---------------------------------------------------------------------------

CREATE TABLE expense_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id     uuid   NOT NULL,
    group_id       uuid   NOT NULL,
    position       int    NOT NULL,
    description    text   NOT NULL,
    amount_cents   bigint NOT NULL,
    split_strategy text   NOT NULL,
    split_params   jsonb  NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT expense_items_amount_is_positive CHECK (amount_cents > 0),
    CONSTRAINT expense_items_position_not_negative CHECK (position >= 0),
    CONSTRAINT expense_items_description_not_blank CHECK (btrim(description) <> ''),
    CONSTRAINT expense_items_strategy_is_known CHECK (split_strategy IN (
        'equally', 'exact_amounts', 'percentages', 'shares', 'mixed',
        'proportional_to_consumption'
    )),

    CONSTRAINT expense_items_belong_to_expense
        FOREIGN KEY (expense_id, group_id)
        REFERENCES expenses (id, group_id) ON DELETE CASCADE,

    CONSTRAINT expense_items_position_unique UNIQUE (expense_id, position),
    CONSTRAINT expense_items_id_group_unique UNIQUE (id, group_id)
);

-- Who was in on each item. The position fixes the order the domain's
-- positional splits rely on: percentages[0] belongs to participant 0.
CREATE TABLE expense_item_participants (
    item_id  uuid NOT NULL,
    group_id uuid NOT NULL,
    user_id  uuid NOT NULL,
    position int  NOT NULL,

    PRIMARY KEY (item_id, user_id),

    CONSTRAINT expense_item_participants_position_not_negative CHECK (position >= 0),
    CONSTRAINT expense_item_participants_position_unique UNIQUE (item_id, position),

    CONSTRAINT expense_item_participants_belong_to_item
        FOREIGN KEY (item_id, group_id)
        REFERENCES expense_items (id, group_id) ON DELETE CASCADE,

    CONSTRAINT expense_item_participants_user_belongs_to_group
        FOREIGN KEY (group_id, user_id) REFERENCES group_members (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Payments (settling up)
-- ---------------------------------------------------------------------------

-- A partial payment is not a special case. It is simply a transfer for less
-- than what was owed: there is no status column, and no debts table, because
-- the remaining balance already says everything there is to say.
CREATE TABLE payments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     uuid        NOT NULL REFERENCES expense_groups (id),
    from_user    uuid        NOT NULL,
    to_user      uuid        NOT NULL,
    amount_cents bigint      NOT NULL,
    paid_at      timestamptz NOT NULL DEFAULT now(),
    created_by   uuid        NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,

    CONSTRAINT payments_amount_is_positive CHECK (amount_cents > 0),
    CONSTRAINT payments_not_to_self        CHECK (from_user <> to_user),

    CONSTRAINT payments_sender_belongs_to_group
        FOREIGN KEY (group_id, from_user) REFERENCES group_members (group_id, user_id),

    CONSTRAINT payments_receiver_belongs_to_group
        FOREIGN KEY (group_id, to_user) REFERENCES group_members (group_id, user_id)
);

CREATE INDEX payments_by_group ON payments (group_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- THE INVARIANT, enforced by the database
-- ---------------------------------------------------------------------------
--
-- The shares of an expense must add up to exactly its total. This cannot be
-- a plain CHECK, because a CHECK only ever sees one row, and this rule spans
-- many. So it is a DEFERRED constraint trigger: it runs at COMMIT, once the
-- whole expense has been written.
--
-- Deferring is what makes it usable. Inserting an expense and then its shares
-- passes through states where the sum does not match yet; nobody outside the
-- transaction ever sees them, and by COMMIT the numbers have to close.

CREATE FUNCTION assert_expense_shares_add_up() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_expense uuid;
    expected_cents bigint;
    assigned_cents bigint;
BEGIN
    IF TG_TABLE_NAME = 'expenses' THEN
        target_expense := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        target_expense := OLD.expense_id;
    ELSE
        target_expense := NEW.expense_id;
    END IF;

    SELECT total_cents INTO expected_cents
    FROM expenses
    WHERE id = target_expense;

    -- The expense itself is gone (cascade): there is nothing left to check.
    IF expected_cents IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT coalesce(sum(share_cents), 0) INTO assigned_cents
    FROM expense_shares
    WHERE expense_id = target_expense;

    IF assigned_cents <> expected_cents THEN
        RAISE EXCEPTION
            'expense % shares add up to % cents but its total is % cents',
            target_expense, assigned_cents, expected_cents;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER expenses_shares_must_add_up
    AFTER INSERT OR UPDATE OF total_cents ON expenses
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_expense_shares_add_up();

CREATE CONSTRAINT TRIGGER expense_shares_must_add_up
    AFTER INSERT OR UPDATE OR DELETE ON expense_shares
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_expense_shares_add_up();

COMMIT;
