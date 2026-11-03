CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON environments
FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('environment');
