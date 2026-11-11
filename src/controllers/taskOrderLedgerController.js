// Read-only compatibility API for the Task Order Ledger.
import { pmsDb, pmsTables } from '../config/db.js';

export async function getTaskOrderLedger(req, res) {
  try {
    const [rows] = await pmsDb.query(`SELECT l.id, l.task_order_profile_id, l.skill, l.country,
      p.task_order_name AS task_order, p.task_order_code, p.region,
      l.status, l.created_at, l.updated_at
      FROM ${pmsTables.usVisaTaskOrderLedger} l
      LEFT JOIN ${pmsTables.usVisaTaskOrderLedgerProfiles} p ON p.id = l.task_order_profile_id
      ORDER BY l.id ASC`);
    const { taskOrder, search, skill, country } = req.query;
    const keyword = String(search || '').trim().toLowerCase();
    const normalizedOrder = String(taskOrder || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const result = rows.filter((row) => {
      if (country && country !== 'ALL' && country !== 'All Countries' &&
          String(row.country || '').trim().toLowerCase() !== String(country).trim().toLowerCase()) return false;
      if (skill && skill !== 'ALL' && skill !== 'All Skills' &&
          String(row.skill || '').trim().toLowerCase() !== String(skill).trim().toLowerCase()) return false;
      if (normalizedOrder && normalizedOrder !== 'ALLTASKORDERS') {
        const orderInfo = [row.task_order, row.task_order_code, row.region].map((x) => String(x || '').replace(/[^A-Z0-9]/gi, '').toUpperCase());
        const number = normalizedOrder.match(/TO(\d+)/);
        if (!orderInfo.some((x) => x === normalizedOrder || x.includes(normalizedOrder)) &&
          !(number && orderInfo.some((x) => new RegExp(`TO${Number(number[1])}(?![0-9])`).test(x)))) return false;
      }
      if (keyword && ![row.skill, row.country, row.task_order, row.task_order_code].some((x) =>
        String(x || '').toLowerCase().includes(keyword))) return false;
      return true;
    });
    return res.json({ success: true, count: result.length, data: result });
  } catch (error) {
    console.error('Failed to read Task Order ledger:', error);
    return res.status(500).json({ success: false, message: 'Unable to fetch Task Order ledger.' });
  }
}
