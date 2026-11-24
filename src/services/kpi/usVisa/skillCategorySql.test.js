import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillCategoryFilter } from './skillCategorySql.js';

const column = 'c.skill_name_raw';
const categories = ['All English', 'English NIV', 'English IV', 'English ACS', 'Non English', 'Non English IV'];
const [ALL, NIV, IV, ACS, NON, NON_IV] = categories;

// Translate the bound MySQL POSIX space class for the JS regex fixture check.
// The SQL shape is asserted separately; this does not require a database.
function regex(pattern, name) {
  return new RegExp(pattern.replaceAll('[[:space:]', '[\\s'), 'i').test(name);
}

const fixtures = [
  ['GSS 2.0 :: Lebanon - English NIV', [ALL, NIV]],
  ['GSS 2.0 :: Lebanon - English IV', [ALL, IV]],
  ['GSS 2.0 :: Lebanon - English ACS', [ALL, ACS]],
  ['GSS 2.0 :: Lebanon - Arabic NIV', [NON]],
  ['GSS 2.0 :: Lebanon - Arabic IV', [NON, NON_IV]],
  ['GSS 2.0 :: Lebanon - French NIV', [NON]],
  ['GSS 2.0 :: Jordan - English NIV', [ALL, NIV]],
  ['GSS 2.0 :: Bangladesh - US - English IV', [ALL, IV]],
  ['Australia-CALL English ACS', [ALL, ACS]],
  ['Philippines-Tagalog IV', [NON, NON_IV]],
  ['GSS 2.0 :: Lebanon - Non English NIV', [NON]],
  ['GSS 2.0 :: Lebanon - Non-English IV', [NON, NON_IV]],
  ['NonEnglish ACS', [NON]],
  ['NON_ENGLISH IV', [NON, NON_IV]],
  ['Non - English IV', [NON, NON_IV]],
  ['GSS 2.0 :: Lebanon - eNgLiSh NiV', [ALL, NIV]],
  ['Lebanon - English CHAT NIV', [ALL, NIV]],
  ['Lebanon - Englishish IV', [NON, NON_IV]],
  ['Lebanon - English_NIV', [NON]], // matches the existing client JS word boundary
];

const englishSql = `(LOWER(${column}) REGEXP ? AND LOWER(${column}) NOT REGEXP ?)`;
const ivSql = `(LOWER(${column}) REGEXP ? AND LOWER(${column}) NOT LIKE ?)`;
const expectedSql = {
  [ALL]: englishSql,
  [NIV]: `(${englishSql} AND LOWER(${column}) LIKE ?)`,
  [IV]: `(${englishSql} AND ${ivSql})`,
  [ACS]: `(${englishSql} AND LOWER(${column}) LIKE ?)`,
  [NON]: `(NOT ${englishSql})`,
  [NON_IV]: `(NOT ${englishSql} AND ${ivSql})`,
};

for (const category of categories) {
  test(`${category}: SQL predicate and bound parameters match the language/queue fixtures`, () => {
    const filter = buildSkillCategoryFilter(column, category);
    assert.equal(filter.sql, expectedSql[category]);
    assert.equal((filter.sql.match(/\?/g) || []).length, filter.values.length);
    const [englishPattern, nonEnglishPattern, queuePattern, excludeQueue] = filter.values;
    for (const [name, expected] of fixtures) {
      const isEnglish = regex(englishPattern, name) && !regex(nonEnglishPattern, name);
      let matches = category === NON || category === NON_IV ? !isEnglish : isEnglish;
      if (category === NIV || category === ACS) {
        matches &&= name.toLowerCase().includes(queuePattern.slice(1, -1));
      } else if (category === IV || category === NON_IV) {
        matches &&= regex(queuePattern, name) && !name.toLowerCase().includes(excludeQueue.slice(1, -1));
      }
      assert.equal(matches, expected.includes(category), name);
    }
  });
}

test('Lebanon reproduces the legacy false match and is no longer excluded', () => {
  const name = 'GSS 2.0 :: Lebanon - English NIV';
  assert.equal(regex('non[[:space:]_-]*english', name), true);
  const filter = buildSkillCategoryFilter(column, ALL);
  assert.equal(regex(filter.values[0], name), true);
  assert.equal(regex(filter.values[1], name), false);
});

test('category aliases normalize; exact and special Philippines skill filters stay repository-owned', () => {
  const expected = buildSkillCategoryFilter(column, ALL);
  for (const alias of ['englishall', 'English', 'all_english', ' ALL-ENGLISH ']) {
    assert.deepEqual(buildSkillCategoryFilter(column, alias), expected);
  }
  for (const skill of ['GSS 2.0 :: Lebanon - English NIV', '__SEASIA_PHILIPPINES__', 'All Skills', '', null]) {
    assert.equal(buildSkillCategoryFilter(column, skill), null);
  }
  const agent = buildSkillCategoryFilter('a.skill_name_raw', NON_IV);
  assert.equal(agent.sql, expectedSql[NON_IV].replaceAll(column, 'a.skill_name_raw'));
  assert.deepEqual(agent.values, buildSkillCategoryFilter(column, NON_IV).values);
});
