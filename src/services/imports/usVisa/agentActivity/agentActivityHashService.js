import crypto from "crypto";
const norm = v => v == null ? "" : String(v).trim().replace(/\s+/g," ").toUpperCase();
const hash = fields => crypto.createHash("sha256").update(JSON.stringify(fields.map(norm))).digest("hex");
export function buildAgentActivityIdentityParts(r={}) {return ["ACTIVITY_V2",r.source_system,r.interval_role,r.agent_name_raw,r.production_date,r.start_at,r.end_at,r.status_raw,r.session_type_raw,r.logged_in_raw,r.application_raw,r.clid_raw,r.agent_login_raw,r.personal_id_raw,r.client_raw,r.os_raw,r.ip_raw];}
export function createAgentActivityIdentityHash(r={}) {return hash(buildAgentActivityIdentityParts(r));}
export function createAgentActivityContentHash(r={}) {return hash([...buildAgentActivityIdentityParts(r),r.duration_seconds]);}
