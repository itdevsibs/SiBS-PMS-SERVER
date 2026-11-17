import express from 'express';
import { pmsDb, dbTable, PMS_DB_NAME } from '../../config/db.js';

const router = express.Router();
const ledgerTable = () => dbTable(PMS_DB_NAME, 'frontsteps_employee_ledger');

const mapRow = (row) => ({
  sibsId: row.sibs_id,
  name: row.name,
  account: row.account || 'FRONTSTEPS',
  tier: row.tier || '',
  lob: row.lob || '-',
  salesforceName: row.salesforce_name || '',
  tl: row.tl || '',
  om: row.om || '',
  site: row.site || '',
  pstDate: row.pst_date || '',
  hireDate: row.hire_date || '',
  productionDate: row.production_date || '',
  departureDate: row.departure_date || '',
  status: row.status || 'Active',
});

router.get('/', async (_req, res) => {
  try {
    const [rows] = await pmsDb.query(
      `SELECT sibs_id, name, account, tier, lob, salesforce_name, tl, om, site, pst_date, hire_date, production_date, departure_date, status FROM ${ledgerTable()} ORDER BY id ASC`
    );
    res.json({ success: true, data: rows.map(mapRow) });
  } catch (error) {
    console.error('Error fetching FrontSteps employee ledger:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch FrontSteps employee ledger' });
  }
});

router.put('/:sibsId', async (req, res) => {
  try {
    const { sibsId } = req.params;
    const {
      name,
      tier,
      lob,
      salesforceName,
      tl,
      om,
      site,
      pstDate,
      hireDate,
      productionDate,
      departureDate,
      status,
    } = req.body || {};

    await pmsDb.query(
      `UPDATE ${ledgerTable()}
       SET name = ?, tier = ?, lob = ?, salesforce_name = ?, tl = ?, om = ?, site = ?, pst_date = ?, hire_date = ?, production_date = ?, departure_date = ?, status = ?
       WHERE sibs_id = ?`,
      [
        name || '',
        tier && tier !== '-' ? tier : null,
        lob || null,
        salesforceName || null,
        tl || null,
        om || null,
        site || null,
        pstDate || null,
        hireDate || null,
        productionDate || null,
        departureDate || null,
        status || 'Active',
        sibsId,
      ]
    );

    const [rows] = await pmsDb.query(
      `SELECT sibs_id, name, account, tier, lob, salesforce_name, tl, om, site, pst_date, hire_date, production_date, departure_date, status FROM ${ledgerTable()} WHERE sibs_id = ? LIMIT 1`,
      [sibsId]
    );

    res.json({ success: true, data: rows[0] ? mapRow(rows[0]) : null });
  } catch (error) {
    console.error('Error updating FrontSteps employee ledger:', error);
    res.status(500).json({ success: false, message: 'Failed to update FrontSteps employee ledger' });
  }
});

export default router;
