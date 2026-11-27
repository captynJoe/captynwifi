// "Your 6 HR Pass ended at 3:44 pm on 16 Nov." -- what a customer is told when
// a package they try to use has run out, instead of a bare refusal.
export function packageEndedMessage(planName: string | null, endedAt: Date, now = new Date()): string {
  const eat = (d: Date) => new Date(d.getTime() + 3 * 3600 * 1000);
  const end = eat(endedAt);
  const today = eat(now).toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  const hours = end.getUTCHours();
  const time = `${hours % 12 || 12}:${String(end.getUTCMinutes()).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
  const day = today ? "today" : `on ${end.getUTCDate()} ${end.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
  return `Your ${planName || "package"} ended at ${time} ${day}. Choose a package to get back online.`;
}
