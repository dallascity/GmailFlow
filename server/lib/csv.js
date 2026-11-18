import Papa from 'papaparse';

/**
 * Excel'in Türkçe ayarlarla doğru açabilmesi için UTF-8 BOM + ';' ayırıcıyla CSV döner.
 */
export function csvResponse(reply, filename, header, rows) {
  const csv = '﻿' + Papa.unparse({ fields: header, data: rows }, { delimiter: ';' });
  const safe = filename.replace(/[\\/:*?"<>|]+/g, '_');
  reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`);
  return csv;
}
