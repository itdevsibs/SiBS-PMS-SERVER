// Task Order country ownership snapshots. Published versions are never edited.
import { pmsDb, pmsTables } from '../../config/db.js';
import { buildVersionSnapshot, VersioningError, diffVersionCountries, hashVersionContent, hydrateVersionSnapshotRows, diffVersionProfileSources } from './taskOrderVersionDomain.js';
const V = pmsTables.usVisaTaskOrderVersions;
const C = pmsTables.usVisaTaskOrderVersionCountries;
const P = pmsTables.usVisaTaskOrderVersionProfiles;
const H = pmsTables.usVisaTaskOrderVersionHead;

export async function getPublishedVersion(requested = 'current', db = pmsDb) {
  const current = requested == null || requested === '' || String(requested).toLowerCase() === 'current';
  let id = Number(requested);
  if (!current && (!Number.isSafeInteger(id) || id < 1)) {
    throw new VersioningError('Task Order version must be Current or a positive version ID.', 'INVALID_VERSION');
  }
  if (current) {
    const [[head]] = await db.query(`SELECT current_version_id FROM ${H} WHERE id = 1`);
    if (!head) throw new VersioningError('Task Order versions are not initialized. Run the baseline bootstrap.', 'VERSION_NOT_INITIALIZED', 503);
    id = Number(head.current_version_id);
  }
  const [[version]] = await db.query(`SELECT id, version_number, label, description, origin, content_hash,
    country_count, profile_count, change_group_id, business_effective_date,
    published_by, UNIX_TIMESTAMP(published_at) AS published_at_epoch FROM ${V}
    WHERE id = ? AND is_published = 1`, [id]);
  if (!version) throw new VersioningError(`Task Order version ${id} was not found.`, 'VERSION_NOT_FOUND', 404);
  return {id:Number(version.id), versionNumber:Number(version.version_number), label:version.label,
    description:version.description, origin:version.origin, contentHash:version.content_hash,
    countryCount:Number(version.country_count), profileCount:Number(version.profile_count),
    changeGroupId:version.change_group_id, businessEffectiveDate:version.business_effective_date,
    publishedBy:version.published_by, publishedAtEpoch:Number(version.published_at_epoch),
    requested: current ? 'current' : String(requested), isCurrentAtResolution:current};
}

export async function readVersionSnapshot(requested = 'current', db = pmsDb) {
  const version = await getPublishedVersion(requested, db);
  const [countries, profiles] = await Promise.all([
    db.query(`SELECT country_key AS countryKey, country_label AS countryLabel, country_aliases AS countryAliases, profile_id AS profileId
      FROM ${C} WHERE version_id = ? ORDER BY country_key`, [version.id]),
    db.query(`SELECT profile_id AS profileId, task_order_code AS code, task_order_name AS name,
      region, description, is_active AS active, source_system AS sourceSystem FROM ${P} WHERE version_id = ? ORDER BY profile_id`, [version.id]),
  ]);
  const {countries:countriesResolved, profiles:profilesResolved} =
    hydrateVersionSnapshotRows(countries[0], profiles[0]);
  if (countriesResolved.length!==version.countryCount || profilesResolved.length!==version.profileCount ||
      hashVersionContent(countriesResolved,profilesResolved)!==version.contentHash) {
    throw new VersioningError('Published Task Order snapshot has changed since publication.',
      'SNAPSHOT_INTEGRITY_FAILED',409);
  }
  return {version, countries:countriesResolved,profiles:profilesResolved};
}

export async function listPublishedVersions({page=1,limit=15} = {}) {
  const safePage = Math.max(1,Math.trunc(Number(page)||1));
  const safeLimit = Math.min(500,Math.max(1,Math.trunc(Number(limit)||15)));
  const [[count]] = await pmsDb.query(`SELECT COUNT(*) AS total FROM ${V} WHERE is_published = 1`);
  const [[head]] = await pmsDb.query(`SELECT current_version_id FROM ${H} WHERE id = 1`);
  const [rows] = await pmsDb.query(`SELECT id, version_number, label, description, origin, country_count,
    profile_count, content_hash, published_by, UNIX_TIMESTAMP(published_at) AS published_at_epoch
    FROM ${V} WHERE is_published = 1 ORDER BY version_number DESC LIMIT ? OFFSET ?`,
  [safeLimit,(safePage-1)*safeLimit]);
  return {rows:rows.map((row) => ({...row,id:Number(row.id),version_number:Number(row.version_number),
    isCurrent:Number(head?.current_version_id) === Number(row.id)})),
    total:Number(count.total),page:safePage,pageSize:safeLimit,
    currentVersionId:head ? Number(head.current_version_id) : null};
}

export async function compareVersionSnapshots(baseRequested, targetRequested) {
  const [base, target] = await Promise.all([readVersionSnapshot(baseRequested), readVersionSnapshot(targetRequested)]);
  const changes = diffVersionCountries(base.countries,target.countries);
  const labels = (snapshot) => new Map(snapshot.profiles.map((p) => [p.profileId,p.name]));
  const a = labels(base), b=labels(target);
  return {baseVersion:base.version,targetVersion:target.version,
    countryMovements:changes.map((change) => ({...change,
      previousTaskOrder:a.get(change.previousProfileId)||null,
      newTaskOrder:b.get(change.newProfileId)||null})),
    sourceMovements:diffVersionProfileSources(base.profiles,target.profiles),
    identical:base.version.contentHash === target.version.contentHash};
}

// Protect immutable audit history from out-of-band edits to the live ledger.
// Called after the management advisory lock and BEGIN, before any SQL mutation.
export async function assertLiveLedgerMatchesPublishedHead(conn) {
  const [[head]] = await conn.query(`SELECT current_version_id FROM ${H} WHERE id = 1 FOR UPDATE`);
  if (!head) throw new VersioningError('Publish V1 baseline before editing the Task Order Ledger.',
    'VERSION_NOT_INITIALIZED', 409);
  const [[published]] = await conn.query(`SELECT content_hash FROM ${V} WHERE id = ? AND is_published = 1`,
    [head.current_version_id]);
  if (!published) throw new VersioningError('The current Task Order version is missing or not published.',
    'SNAPSHOT_INTEGRITY_FAILED', 409);
  const [rows] = await conn.query(`SELECT country, task_order_profile_id, status FROM ${pmsTables.usVisaTaskOrderLedger} ORDER BY id ASC`);
  const [profiles] = await conn.query(`SELECT id, task_order_code, task_order_name, region, description, is_active, source_system FROM ${pmsTables.usVisaTaskOrderLedgerProfiles} ORDER BY id ASC`);
  const [[sourceSnapshot]] = await conn.query(`SELECT COUNT(*) AS sourced FROM ${P} WHERE version_id = ? AND source_system IS NOT NULL`, [head.current_version_id]);
  const live = buildVersionSnapshot(rows, profiles, {includeSourceSystem:Number(sourceSnapshot.sourced)>0});
  if (live.contentHash !== published.content_hash) throw new VersioningError(
    'The live Task Order Ledger differs from its published version. Audit out-of-band changes before editing.',
    'LIVE_LEDGER_VERSION_MISMATCH', 409);
  return Number(head.current_version_id);
}

// This MUST be invoked inside the same connection/transaction/GET_LOCK as a ledger edit.
// Caller is responsible for COMMIT or ROLLBACK.
export async function publishVersionInTransaction(conn, {publishedBy,changeGroupId=null,
  reason='Task Order ownership update',businessEffectiveDate=null,baseline=false} = {}) {
  const [[head]] = await conn.query(`SELECT current_version_id FROM ${H} WHERE id = 1 FOR UPDATE`);
  if (baseline && head?.current_version_id) return {created:false, id:Number(head.current_version_id)};
  if (!baseline && !head) throw new VersioningError('Publish V1 baseline before editing the ledger.', 'VERSION_NOT_INITIALIZED', 409);
  const [rows] = await conn.query(`SELECT country,task_order_profile_id,status FROM ${pmsTables.usVisaTaskOrderLedger} ORDER BY id ASC`);
  const [profiles] = await conn.query(`SELECT id,task_order_code,task_order_name,region,description,is_active FROM ${pmsTables.usVisaTaskOrderLedgerProfiles} ORDER BY id ASC`);
  const snapshot = buildVersionSnapshot(rows,profiles,{includeSourceSystem:true});
  if (head && !baseline) {
    const [[latest]] = await conn.query(`SELECT content_hash FROM ${V} WHERE id = ?`, [head.current_version_id]);
    if (latest?.content_hash === snapshot.contentHash) return {created:false, id:Number(head.current_version_id)};
  }
  const [[maxRow]] = await conn.query(`SELECT COALESCE(MAX(version_number), 0) AS latest FROM ${V}`);
  const versionNumber = Number(maxRow.latest)+1;
  const [result] = await conn.query(`INSERT INTO ${V}
    (version_number,label,description,origin,change_group_id,created_by,published_by,
    content_hash,country_count,profile_count,business_effective_date,is_published,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,NOW(6))`,
  [versionNumber,baseline?'V1 — Initial Baseline':`V${versionNumber} — Published`,reason,
    baseline?'BASELINE':'LEDGER_EDIT',changeGroupId,publishedBy,publishedBy,
    snapshot.contentHash,snapshot.countries.length,snapshot.profiles.length,businessEffectiveDate]);
  const versionId = Number(result.insertId);
  if (snapshot.profiles.length) {
    await conn.query(`INSERT INTO ${P} (version_id,profile_id,task_order_code,task_order_name,region,description,is_active,source_system)
      VALUES ${snapshot.profiles.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`,
    snapshot.profiles.flatMap((p) => [versionId,p.profileId,p.code,p.name,p.region,p.description,p.active,p.sourceSystem]));
  }
  if (snapshot.countries.length) {
    await conn.query(`INSERT INTO ${C} (version_id,country_key,country_label,country_aliases,profile_id)
      VALUES ${snapshot.countries.map(() => '(?,?,?,?,?)').join(',')}`,
    snapshot.countries.flatMap((c) => [versionId,c.countryKey,c.countryLabel,JSON.stringify(c.countryAliases),c.profileId]));
  }
  if (head) await conn.query(`UPDATE ${H} SET current_version_id = ?,updated_by = ? WHERE id=1`,[versionId,publishedBy]);
  else await conn.query(`INSERT INTO ${H} (id,current_version_id,updated_by) VALUES (1,?,?)`,[versionId,publishedBy]);
  return {created:true,id:versionId,versionNumber,countryCount:snapshot.countries.length,
    contentHash:snapshot.contentHash};
}
