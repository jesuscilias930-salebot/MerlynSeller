-- Independent cash ledger. It does not import sales or charge bank accounts.
CREATE TABLE finance_accounts (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'MXN' CHECK (currency = 'MXN'),
  opening_date date NOT NULL,
  opening_balance_cents bigint NOT NULL CHECK (abs(opening_balance_cents) <= 99999999999),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE finance_fixed_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES finance_accounts(organization_id),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 200),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  due_day integer NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  start_month date NOT NULL CHECK (extract(day FROM start_month) = 1),
  end_month date CHECK (extract(day FROM end_month) = 1 AND end_month >= start_month),
  is_active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE TABLE finance_movements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES finance_accounts(organization_id),
  kind text NOT NULL CHECK (kind IN ('income', 'expense')),
  movement_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 200),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  fixed_expense_id uuid,
  fixed_month date,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  voided_at timestamptz,
  void_reason text NOT NULL DEFAULT '' CHECK (char_length(void_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, fixed_expense_id) REFERENCES finance_fixed_expenses(organization_id, id),
  CHECK ((fixed_expense_id IS NULL AND fixed_month IS NULL) OR
    (fixed_expense_id IS NOT NULL AND fixed_month IS NOT NULL AND extract(day FROM fixed_month) = 1 AND kind = 'expense'))
);
CREATE INDEX finance_movements_month_idx ON finance_movements (organization_id, movement_date DESC, created_at DESC, id);
CREATE UNIQUE INDEX finance_fixed_payment_once_idx ON finance_movements (organization_id, fixed_expense_id, fixed_month)
  WHERE fixed_expense_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX finance_fixed_expenses_org_idx ON finance_fixed_expenses (organization_id, is_active, created_at DESC, id);
CREATE TABLE finance_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES finance_accounts(organization_id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_id text NOT NULL,
  previous_value jsonb,
  next_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_audit_org_idx ON finance_audit (organization_id, created_at DESC);
