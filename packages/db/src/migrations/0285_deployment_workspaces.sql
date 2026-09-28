-- Workspace declarations use the existing stable resource ledger. Guard native
-- writes and deletes, including primary-selection side effects from other rows.
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON project_workspaces
FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('workspace');
