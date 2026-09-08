-- 004_multi_currency.sql
--
-- A group no longer has a currency. Its expenses do.
--
-- Until now a group was created in one currency and everything inside it was
-- assumed to be in that currency, which was never really true: people pay for
-- dinner in bolivianos, a hotel in dollars and each other in USDT. So the
-- currency moves down from the group to the individual expense, and the
-- ledger gets a single unit of its own to settle in: USDT.
--
-- THE COLUMN NAMING RULE, so nobody ever has to guess:
--
--   *_cents        the amount in the row's OWN currency_code
--   *_usdt_cents   the same money, converted, in the unit the ledger uses
--
-- WHY THE RATE IS A COLUMN AND NOT A LOOKUP:
--
-- Because an expense is a fact, and the rate that night is part of the fact.
-- If the ledger stored bolivianos and converted them at read time, balances
-- would move on their own overnight, a payment made in full would stop being
-- in full by morning, and last week's balance could never be reproduced.
-- Worse, the invariant would break outright: round(a x r) + round(b x r) is
-- not round((a + b) x r), so shares would stop adding up to their total the
-- moment a rate moved. Frozen here, the arithmetic happens once, on the way
-- in, and everything downstream keeps working in one unit.
--
-- See src/domain/currency.ts for the conversion itself.

BEGIN;

-- ---------------------------------------------------------------------------
-- Groups lose their currency
-- ---------------------------------------------------------------------------

ALTER TABLE expense_groups DROP CONSTRAINT expense_groups_currency_is_iso;
ALTER TABLE expense_groups DROP COLUMN currency_code;

-- ---------------------------------------------------------------------------
-- Expenses gain one
-- ---------------------------------------------------------------------------

-- The defaults are here so the existing rows have somewhere to land. Every
-- amount already in the table was recorded before this migration existed, and
-- there is no honest rate to apply to it after the fact -- we do not know what
-- the boliviano was worth the night that dinner happened. Adopting them as
-- USDT at par leaves every balance in the app exactly where it was, which is
-- the one outcome that surprises nobody.
ALTER TABLE expenses
    ADD COLUMN currency_code    text   NOT NULL DEFAULT 'USDT',
    ADD COLUMN rate_micros      bigint NOT NULL DEFAULT 1000000,
    ADD COLUMN total_usdt_cents bigint;

UPDATE expenses SET total_usdt_cents = total_cents;

ALTER TABLE expenses
    ALTER COLUMN total_usdt_cents SET NOT NULL,

    ADD CONSTRAINT expenses_currency_is_spendable
        CHECK (currency_code IN ('USDT', 'BOB', 'USD')),

    ADD CONSTRAINT expenses_rate_is_positive
        CHECK (rate_micros > 0),

    ADD CONSTRAINT expenses_usdt_total_is_positive
        CHECK (total_usdt_cents > 0),

    -- USDT converts to itself, and only at par. Without this, "1 USDT =
    -- 1,02 USDT" would be a rate the database happily accepts, and an
    -- expense of 100 USDT would land in the ledger as 98.
    ADD CONSTRAINT expenses_usdt_is_its_own_unit
        CHECK (currency_code <> 'USDT'
               OR (rate_micros = 1000000 AND total_usdt_cents = total_cents));

-- ---------------------------------------------------------------------------
-- And so do the shares
-- ---------------------------------------------------------------------------

-- share_cents stays what it was: the amount in the expense's own currency,
-- which is what the person actually agreed to ("Ana pone Bs 40"). The USDT
-- column beside it is what the ledger adds up.
ALTER TABLE expense_shares
    ADD COLUMN share_usdt_cents bigint;

UPDATE expense_shares SET share_usdt_cents = share_cents;

-- Postgres refuses to ALTER a table that has trigger events waiting, and the
-- UPDATE above just queued one per row against the DEFERRED constraint
-- trigger on this table. Forcing them to run now empties the queue -- and
-- they pass, because nothing that UPDATE touched is anything the trigger
-- looks at yet. Without this line the next statement dies with "cannot ALTER
-- TABLE because it has pending trigger events", which is a sentence that
-- explains nothing about what is actually wrong.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE expense_shares
    ALTER COLUMN share_usdt_cents SET NOT NULL,
    ADD CONSTRAINT expense_shares_usdt_not_negative
        CHECK (share_usdt_cents >= 0);

-- ---------------------------------------------------------------------------
-- Payments too: you can hand somebody bolivianos to settle a USDT debt
-- ---------------------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN currency_code     text   NOT NULL DEFAULT 'USDT',
    ADD COLUMN rate_micros       bigint NOT NULL DEFAULT 1000000,
    ADD COLUMN amount_usdt_cents bigint;

UPDATE payments SET amount_usdt_cents = amount_cents;

ALTER TABLE payments
    ALTER COLUMN amount_usdt_cents SET NOT NULL,

    ADD CONSTRAINT payments_currency_is_spendable
        CHECK (currency_code IN ('USDT', 'BOB', 'USD')),

    ADD CONSTRAINT payments_rate_is_positive
        CHECK (rate_micros > 0),

    ADD CONSTRAINT payments_usdt_amount_is_positive
        CHECK (amount_usdt_cents > 0),

    ADD CONSTRAINT payments_usdt_is_its_own_unit
        CHECK (currency_code <> 'USDT'
               OR (rate_micros = 1000000 AND amount_usdt_cents = amount_cents));

-- ---------------------------------------------------------------------------
-- THE INVARIANT, now in two currencies
-- ---------------------------------------------------------------------------
--
-- The shares of an expense had to add up to its total. Now they have to do it
-- twice: once in the currency the money was spent in, and once in the unit
-- the ledger settles in. Checking only the USDT column would let a split that
-- does not match what people agreed to slip through as long as the converted
-- numbers happened to close; checking only the native one would let the
-- ledger itself go crooked, which is the half that actually costs money.
--
-- Still deferred, for the same reason as before: writing an expense passes
-- through states where the sums do not match yet, and nobody outside the
-- transaction ever sees them.

CREATE OR REPLACE FUNCTION assert_expense_shares_add_up() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_expense  uuid;
    expected_native bigint;
    expected_usdt   bigint;
    assigned_native bigint;
    assigned_usdt   bigint;
BEGIN
    IF TG_TABLE_NAME = 'expenses' THEN
        target_expense := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        target_expense := OLD.expense_id;
    ELSE
        target_expense := NEW.expense_id;
    END IF;

    SELECT total_cents, total_usdt_cents
      INTO expected_native, expected_usdt
      FROM expenses
     WHERE id = target_expense;

    -- The expense itself is gone (cascade): there is nothing left to check.
    IF expected_native IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT coalesce(sum(share_cents), 0), coalesce(sum(share_usdt_cents), 0)
      INTO assigned_native, assigned_usdt
      FROM expense_shares
     WHERE expense_id = target_expense;

    IF assigned_native <> expected_native THEN
        RAISE EXCEPTION
            'expense % shares add up to % but its total is %',
            target_expense, assigned_native, expected_native;
    END IF;

    IF assigned_usdt <> expected_usdt THEN
        RAISE EXCEPTION
            'expense % shares add up to % USDT cents but its total is % USDT cents',
            target_expense, assigned_usdt, expected_usdt;
    END IF;

    RETURN NULL;
END;
$$;

-- The trigger on expenses watched total_cents. It has to watch the converted
-- total as well now, and a trigger's column list cannot be altered in place.
DROP TRIGGER expenses_shares_must_add_up ON expenses;

CREATE CONSTRAINT TRIGGER expenses_shares_must_add_up
    AFTER INSERT OR UPDATE OF total_cents, total_usdt_cents ON expenses
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_expense_shares_add_up();

COMMIT;
