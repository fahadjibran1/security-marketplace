export function formatScreeningDate(value?: string | null) {
  if (!value) return "Present";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

export function screeningDateToIso(value: string) {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error("Enter dates as DD/MM/YYYY.");
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) throw new Error("Enter a valid date as DD/MM/YYYY.");
  return iso;
}

export function normalizeScreeningPostcode(value: string) {
  const compact = value.trim().toUpperCase().replace(/\s+/g, "");
  if (compact === "GIR0AA") return "GIR 0AA";
  if (compact.length < 5 || compact.length > 7)
    throw new Error("Enter a valid UK postcode.");
  const normalized = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  if (!/^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(normalized))
    throw new Error("Enter a valid UK postcode.");
  return normalized;
}
