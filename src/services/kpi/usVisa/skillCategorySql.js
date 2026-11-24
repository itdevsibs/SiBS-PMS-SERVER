// Keep SQL category matching in sync with the client's matchesSkillCategory.
// ASCII word boundaries include underscore as a word character (JS \b).
// Without the leading boundary, "Lebanon - English" matches "non - English".
const ENGLISH_PATTERN = '(^|[^a-z0-9_])english($|[^a-z0-9_])';
const NON_ENGLISH_PATTERN = '(^|[^a-z0-9_])non[[:space:]_-]*english($|[^a-z0-9_])';
const IV_PATTERN = '(^|[^a-z])iv($|[^a-z])';

// column must be a trusted, hardcoded SQL column reference, never user input.
// Return null for individual skills so each repository retains its own matching.
export function buildSkillCategoryFilter(column, category) {
  const key = String(category || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const name = `LOWER(${column})`;
  const english = `(${name} REGEXP ? AND ${name} NOT REGEXP ?)`;
  const languageValues = [ENGLISH_PATTERN, NON_ENGLISH_PATTERN];
  const iv = `(${name} REGEXP ? AND ${name} NOT LIKE ?)`;
  const ivValues = [IV_PATTERN, '%niv%'];

  switch (key) {
    case 'englishall':
    case 'english':
    case 'allenglish':
      return { sql: english, values: languageValues };
    case 'englishniv':
      return { sql: `(${english} AND ${name} LIKE ?)`, values: [...languageValues, '%niv%'] };
    case 'englishiv':
      return { sql: `(${english} AND ${iv})`, values: [...languageValues, ...ivValues] };
    case 'englishacs':
      return { sql: `(${english} AND ${name} LIKE ?)`, values: [...languageValues, '%acs%'] };
    case 'nonenglish':
      return { sql: `(NOT ${english})`, values: languageValues };
    case 'nonenglishiv':
      return { sql: `(NOT ${english} AND ${iv})`, values: [...languageValues, ...ivValues] };
    default:
      return null;
  }
}
