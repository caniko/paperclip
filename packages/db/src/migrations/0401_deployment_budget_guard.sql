CREATE FUNCTION paperclip_deployment_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('paperclip.deployment_apply', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM deployment_resources
    WHERE kind = OLD.scope_type AND kind IN ('company', 'agent') AND resource_id = OLD.scope_id AND fields ? 'budgetMonthlyCents'
  ) AND OLD.metric = 'billed_cents' AND OLD.window_kind = 'calendar_month_utc' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Declaratively owned budget policy cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.is_active IS DISTINCT FROM OLD.is_active
      OR NEW.hard_stop_enabled IS DISTINCT FROM OLD.hard_stop_enabled OR NEW.metric IS DISTINCT FROM OLD.metric
      OR NEW.window_kind IS DISTINCT FROM OLD.window_kind OR NEW.unpriced_usage_policy IS DISTINCT FROM OLD.unpriced_usage_policy THEN
      RAISE EXCEPTION 'Declaratively owned budget policy cannot be changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON budget_policies FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_budget_guard();
