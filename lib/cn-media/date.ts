export function todayYmdShanghai(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
export function validYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
