-- 005_voided_payments_stay_visible.sql
--
-- A payment that was undone stops counting, but it stops disappearing.
--
-- The row was never deleted: voidPayment has always been an UPDATE that sets
-- deleted_at, exactly like an expense. What made it vanish was the READ —
-- every query filtered `deleted_at IS NULL`, so the ledger kept the truth and
-- the screen showed a history with a hole in it. Somebody could record a
-- payment, undo it, and leave no trace anybody could see.
--
-- So the history query stops filtering (see payments-repository.ts) and this
-- migration adds the one thing the row could not answer on its own: WHO undid
-- it. "Anulado" with no name is barely better than the payment being gone.
--
-- NOT the same as who created it. The person who recorded a payment and the
-- person who struck it through are often different people — the group's
-- creator can undo somebody else's, and that is precisely the case worth
-- being able to see.

BEGIN;

ALTER TABLE payments
    ADD COLUMN deleted_by uuid REFERENCES users (id);

-- NOT VALID on purpose, and it is the honest choice rather than a shortcut.
--
-- There are already voided payments in this database and nobody recorded who
-- voided them. Backfilling deleted_by with created_by would be inventing an
-- author for something we do not know, and a made-up name in an audit trail
-- is worse than an admitted gap. NOT VALID leaves those rows alone while
-- forcing every void from now on to name its author; the UI shows the old
-- ones as "anulado" and the new ones as "anulado por X".
ALTER TABLE payments
    ADD CONSTRAINT payments_void_names_its_author
    CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL)
    NOT VALID;

COMMIT;
