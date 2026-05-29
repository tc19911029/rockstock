import { detectTrend } from '../lib/chips/trends';

const trust = [255, 117, 1, 83, -143, 62, -81, 17, 0, 68, 38, 5, -25, -81, -182];
const dealer = [-14, 10, 94, -83, -99, 19, -70, 44, -13, 25, 52, 10, 12, -2, -42];
const foreign = [-395, 191, 314, 78, -513, 175, 401, -278, -124, 126, -127, -179, -210, -292, 200];
const margin = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 10, 4, 22];

console.log("trust:", JSON.stringify(detectTrend(trust)));
console.log("dealer:", JSON.stringify(detectTrend(dealer)));
console.log("foreign:", JSON.stringify(detectTrend(foreign)));
console.log("margin:", JSON.stringify(detectTrend(margin, 'inc_dec')));
