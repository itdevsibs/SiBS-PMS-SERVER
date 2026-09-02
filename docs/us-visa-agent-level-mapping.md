# US Visa Agent Level Mapping Notes

## Sample Inspection Status

Step 1 required inspection of actual Fusecom, FuseNet, and HeroDash Agent Level Excel samples before source-specific mapping. No Agent Level source workbooks were present in the workspace or common local folders at the time of implementation.

Files found and inspected:

- `C:\Users\dwightanthonyb\Downloads\Fusecom_Skill Statistics Inbound Jul26-Aug1, 2026.xlsx`
- `C:\Users\dwightanthonyb\Downloads\Herodash_Skill Statistics Inbound Jul26-Aug1, 2026.xlsx`
- `C:\Users\dwightanthonyb\Documents\pauldash_Skill Statistics Inbound Jul26-Aug1, 2026.xlsx`
- `C:\Users\dwightanthonyb\Downloads\SIBS_WFM_Raw_KPI_Import_Jul_2026_Batch2.xlsx`
- `C:\Users\dwightanthonyb\Downloads\SIBS_WFM_Raw_KPI_Import_Jul_2026_Batch3.xlsx`
- `C:\Users\dwightanthonyb\Downloads\US VISA Master Roster File  (PMS).xlsx`

These are Skill Statistics, generic WFM KPI, or roster files, not Agent Level interaction exports. Because of that, source header mappings below are based on representative Step 2 parser rows and must be verified against actual source exports before production enablement.

## Canonical Structured Fields

| Canonical field | Fusecom source header | FuseNet source header | HeroDash source header | SQL type | Nullable/required | KPI relevance |
| --- | --- | --- | --- | --- | --- | --- |
| id | n/a | n/a | n/a | BIGINT UNSIGNED | required | primary key |
| batch_id | n/a | n/a | n/a | BIGINT UNSIGNED | required | import lineage/filtering |
| raw_import_row_id | n/a | n/a | n/a | BIGINT UNSIGNED | nullable | source-row lineage |
| import_profile_id | n/a | n/a | n/a | BIGINT UNSIGNED | required | profile/source lineage |
| source_system | n/a | n/a | n/a | VARCHAR(50) | required | source filtering/comparison |
| source_sheet | worksheet name | worksheet name | worksheet name | VARCHAR(191) | required | validation/source trace |
| interaction_type | Interaction Type or derived from Skill/Direction | Interaction Type or derived from Skill/Direction | Channel or derived from Skill/Direction | VARCHAR(50) | required | call/email/chat filtering |
| source_interaction_id | Interaction ID / Contact ID / Session ID | Interaction ID / InteractionId / Contact ID | Interaction ID / Contact ID / Conversation ID | VARCHAR(191) | nullable | preferred identity |
| call_id | Call ID / Call Id | Call ID / CallId | Call ID / CallId | VARCHAR(191) | nullable | duplicate matching/call joins |
| production_date | Date / Production Date | Date / Production Date | Date / Production Date | DATE | required | KPI period aggregation |
| agent_name_raw | Agent Name / Agent | Agent / Agent Name | Agent Name / Agent | VARCHAR(191) | nullable | employee mapping/search |
| agent_login | Agent Login / Login | Login / Agent Login / Username | Agent Email / Agent Login / Login | VARCHAR(191) | nullable | employee mapping/search |
| personal_id | Personal ID / Personal Id | Personal ID / Employee ID | Agent ID / Personal ID | VARCHAR(100) | nullable | employee mapping/search |
| source_agent_key | Agent Login / Personal ID / Agent Name | Login / Agent Login / Personal ID / Agent | Agent ID / Agent Email / Agent Name | VARCHAR(191) | nullable | employee mapping/indexing |
| employee_uid | PMS enrichment | PMS enrichment | PMS enrichment | VARCHAR(100) | nullable | roster join/scope |
| mapping_status | PMS enrichment | PMS enrichment | PMS enrichment | ENUM('MATCHED','UNMATCHED','AMBIGUOUS') | required | mapping audit/scope readiness |
| mapping_method | PMS enrichment | PMS enrichment | PMS enrichment | VARCHAR(50) | nullable | mapping audit |
| skill_name_raw | Skill Name / Queue / Skill | Skill / Queue / Skill Name | Skill / Skill Name / Queue Name | VARCHAR(191) | nullable | task order/skill filtering |
| task_order_id | Task Order / Task Order ID | Task Order / Task Order ID | Task Order / Task Order ID | VARCHAR(50) | nullable | role scope/filtering |
| direction | Direction / Call Direction | Direction | Call Direction / Direction | VARCHAR(50) | nullable | inbound/outbound filtering |
| interaction_status | Status / Call Status / Disposition | Disposition / Status | Call Status / Status / Outcome | VARCHAR(100) | nullable | handled/abandoned filtering |
| arrival_at | Arrival Time / Arrival At / Start Time | Offered At / Arrival At / Start Time | Arrival DateTime / Arrival Time / Created At | DATETIME | nullable | service level timing |
| queue_at | Queue Time / Queued At / Queue At | Queued At / Queue At | Queue DateTime / Queue Time / Queued At | DATETIME | nullable | service level timing |
| answer_at | Answer Time / Answered At / Answer At | Connected At / Answered At / Answer At | Answer DateTime / Answer Time / Answered At | DATETIME | nullable | service level timing |
| end_at | End Time / Ended At / End At | Disconnected At / End At / End Time | End DateTime / End Time / Closed At | DATETIME | nullable | handle time |
| queue_seconds | Queue Time (sec) / Queue Seconds | Queue Seconds / Queue Time | Queue Time (sec) / Queue Seconds | DECIMAL(16,4) | nullable | ASA/service level |
| talk_seconds | Talk Time / Talk Time (sec) / Talk Seconds | Talk Seconds / Talk Time | Talk Time (sec) / Talk Seconds | DECIMAL(16,4) | nullable | AHT |
| hold_seconds | Hold Time / Hold Time (sec) / Hold Seconds | Hold Seconds / Hold Time | Hold Time (sec) / Hold Seconds | DECIMAL(16,4) | nullable | AHT |
| after_call_seconds | After Call Time / ACW Time / ACW Seconds | ACW Seconds / After Call Seconds | Wrap-up Time (sec) / After Call Seconds / ACW Seconds | DECIMAL(16,4) | nullable | AHT |
| handle_seconds | Handle Time / Handle Time (sec) / Handle Seconds | Handle Seconds / Handle Time | Handle Time (sec) / Handle Seconds | DECIMAL(16,4) | nullable | AHT |
| hold_count | Hold Count / Holds | Holds / Hold Count | Hold Count / Calls on hold | INT UNSIGNED | nullable | hold behavior |
| disconnect_indicator | Disconnect Indicator / Disconnect Reason | Disconnect Reason / Disconnect Indicator | Disconnect Indicator / Disconnect Reason | VARCHAR(100) | nullable | abandoned/disconnect logic |
| row_json | full original row | full original row | full original row | LONGTEXT | required | audit/source preservation |
| row_identity_hash | generated | generated | generated | CHAR(64) | required | duplicate/conflict identity |
| row_content_hash | generated | generated | generated | CHAR(64) | required | duplicate/conflict content |
| created_at | n/a | n/a | n/a | TIMESTAMP | required | audit |

## Hash Design

Preferred identity:

`source_system + interaction_type + source_interaction_id`

If a source has a call identifier but no separate interaction identifier:

`source_system + interaction_type + call_id`

Pending sample-specific fallback:

Use a deterministic combination of source-system fields that identify a single interaction without fuzzy employee matching. Candidate fallback fields are production date, agent key, timestamps, skill, direction, and status, but the exact fallback must be finalized only after actual Agent Level samples are available.

## Employee Identity Mapping

Agent Level employee matching uses the existing Kronos employee source for exact employee-name lookup and a PMS-owned `us_visa_employee_aliases` table for US Visa source identities that are not native Kronos fields.

Priority:

1. `PERSONAL_ID` alias
2. `AGENT_LOGIN` alias
3. source-specific alias: `FUSECOM_NAME`, `FUSENET_NAME`, or `HERODASH_NAME`
4. exact normalized Kronos `gy_employee.gy_emp_fullname`
5. `UNMATCHED`

Ambiguous matches are not guessed. The interaction remains stored with `employee_uid = NULL`, `mapping_status = 'AMBIGUOUS'`, and an import warning.

## Organizational Scope

US Visa Agent/TL/OM visibility must come from roster hierarchy, not from call skill. The scope foundation stores effective-dated rows in `us_visa_employee_scope_assignments`:

- agent: `employee_uid`
- task order: `task_order_id`
- team leader: `team_leader_uid`
- operations manager: `operations_manager_uid`
- date window: `effective_from` through nullable `effective_to`

Scope is resolved against the Agent Level interaction `production_date` where practical. If an agent transfers from TL X to TL Y, historical performance remains under the TL/OM assignment effective on that production date.

Current role mapping follows the existing JWT/admin access conventions:

- `adminAccess = 8` or role `tl`: Team Leader
- `adminAccess = 5` or role `om`: Operations Manager
- role `employee` or `agent` without admin access: Agent
- WFM/Admin/BOD/SOM remain governed by their existing backend role restrictions and are not widened by Agent/TL/OM scope checks.

## Agent Call KPI Calculation

First-phase Agent KPIs are calculated independently from Skill Statistics using `us_visa_raw_agent_interactions`.

Implemented formulas:

- Handled/answered calls: count of interactions with `answer_at` present or a source status of `ANSWERED`, `HANDLED`, `CONNECTED`, or `COMPLETED`
- Total handle time: sum of `handle_seconds` for answered interactions with handle time present
- Average handle time: total handle seconds divided by answered interactions with handle time present
- Total/average talk time: same pattern using `talk_seconds`
- Total/average hold time: same pattern using `hold_seconds`
- Total after-call time: sum of `after_call_seconds`
- Average after-call time: total after-call seconds divided by answered interactions with after-call time present
- Hold count: sum of `hold_count`

Supported grouping/filtering foundations:

- employee
- skill
- task order
- reporting period
- source system

Not implemented yet:

- Service Level remains `null` with `serviceLevelStatus = 'NOT_CALCULABLE'` because threshold, offered/net offered denominator, short-call, abandoned, failed-call, and DIBP rules are not confirmed for Agent Level sources.
- Abandoned calls remain `null` because source-specific abandoned/failed/short-call treatment has not been confirmed from actual Agent Level exports.

## Skill Statistics vs Agent Level KPI Comparison

Comparison is calculated dynamically for validation and does not persist reconciliation results.

The comparison service calls the existing Skill Statistics KPI service and the new Agent KPI service independently, then compares only matching windows/dimensions:

- source context
- task order
- skill
- reporting period
- date range/reference date

Comparable first-phase metrics:

- `handledCalls`: Skill `callsHandled` compared with Agent `handledCalls`
- `averageHandleSeconds`: Skill `ahtSeconds` compared with Agent `averageHandleSeconds`

Not comparable yet:

- `callsOffered`: Agent Level cannot currently reconstruct offered/net-offered rules
- `abandonedCalls`: Agent abandoned/short/failed-call treatment is not confirmed
- `serviceLevel`: Agent threshold/denominator/DIBP rules are not confirmed

Statuses:

- `MATCH`: exact numeric match
- `DIFFERENT`: exact numeric difference, with no tolerance
- `NOT_COMPARABLE`: metric or window cannot be compared
- `MISSING_SKILL_DATA`: Skill Statistics side is absent
- `MISSING_AGENT_DATA`: Agent Level side is absent

## Role-Scoped Performance APIs

Agent Level performance APIs are exposed under the existing US Visa route tree:

- `GET /api/us-visa/performance/me`
- `GET /api/us-visa/performance/team`
- `GET /api/us-visa/performance/operations`
- `GET /api/us-visa/performance/comparison`

Authorization is always derived from the backend-authenticated JWT context. Query parameters can narrow scope but cannot expand it.

Response contracts:

- Agent `me`: returns `{ scope, performance }` for the authenticated employee only
- TL `team`: returns `{ scope, metadata, summary, agents }` for scoped agents only
- OM `operations`: returns `{ scope, metadata, summary, teamLeaders }`, where each TL contains scoped agents
- WFM comparison: returns dynamic Skill-vs-Agent comparison results from the comparison service

Route gates:

- Agent `me`: authenticated user, then service requires Agent/employee context
- TL `team`: `adminAccess = 8`
- OM `operations`: `adminAccess = 5`
- WFM comparison: existing graph-viewer-style roles `7`, `6`, `9`, `10`

The existing `GET /api/wfm/kpis/calls` route remains separate and unchanged for current Skill Statistics graph use.
