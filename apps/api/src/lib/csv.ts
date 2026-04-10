export function toCsvRow(values: Array<string | number | null | undefined>): string {
  return (
    values
      .map((v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(',') + '\n'
  );
}
