export function formatJapanTime(value:string):string {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) throw new Error('Invalid display date');
  return `${new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date)} 日本時間`;
}
