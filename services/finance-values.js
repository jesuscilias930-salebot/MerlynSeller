const fail = message => Object.assign(new Error(message), {status:400});
exports.today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
exports.validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '2199-12-31' && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
exports.validMonth = value => typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && exports.validDate(`${value}-01`);
exports.nextMonth = month => {const [year,m] = month.split('-').map(Number);return `${year+(m===12?1:0)}-${String(m===12?1:m+1).padStart(2,'0')}-01`;};
exports.dueDate = (month,day) => {
 if(!exports.validMonth(month) || !Number.isInteger(day) || day<1 || day>31)throw fail('Fecha de vencimiento inválida.');
 const [year,m]=month.split('-').map(Number), last=new Date(Date.UTC(year,m,0)).getUTCDate();
 return `${month}-${String(Math.min(day,last)).padStart(2,'0')}`;
};
exports.cents = (value, signed=false) => {
 if(typeof value!=='string' || !(signed?/^-?\d{1,9}(?:\.\d{1,2})?$/:/^\d{1,9}(?:\.\d{1,2})?$/).test(value))throw fail('Escribe un importe válido con hasta dos decimales, sin separadores de miles.');
 const negative=value.startsWith('-'), [whole,fraction='']=value.replace('-','').split('.');
 const n=(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')))*(negative?-1n:1n);
 if((!signed&&n<=0n)||n>99999999999n||n< -99999999999n)throw fail('Revisa el importe: el límite es 999,999,999.99 MXN y los movimientos deben ser mayores que cero.');
 return n;
};
exports.money = value => {const n=BigInt(value),a=n<0n?-n:n;return `${n<0n?'-':''}${a/100n}.${String(a%100n).padStart(2,'0')}`;};
exports.balances = ({opening, before=0, income=0, expense=0, pending=0}) => {
 const start=BigInt(opening)+BigInt(before), balance=start+BigInt(income)-BigInt(expense);
 return {openingBalance:exports.money(start),income:exports.money(income),expense:exports.money(expense),balance:exports.money(balance),pendingFixed:exports.money(pending),afterFixed:exports.money(balance-BigInt(pending))};
};
