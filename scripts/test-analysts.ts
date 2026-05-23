import { resolveAnalystsForVideo, extractAnalystsFromTitle } from '../lib/youtube/analystParser';

const cases: Array<[string, string[] | undefined]> = [
  ['【理財達人秀】4萬點守住 520後還能漲？ 光學跟大戶 失血股要賣？｜李兆華、朱家泓 2026.05.20 part1', ['李兆華']],
  ['【理財達人秀】PCB回神了 籌碼大換手？ 跌深處置、記憶體 撿便宜｜李兆華、權證小哥 2026.05.21 part3', ['李兆華']],
  ['【兆華艾綸說】曲博鐵口：台積電不可能輸！別亂買，玻璃基板還早 ｜李兆華、艾綸、曲建仲', ['李兆華', '艾綸']],
  ['【金融鬼谷子】藍登耀分析師 20260521', ['藍登耀']],
  ['【錢線百分百】20260522完整版(下集)', undefined],
  ['2026/05/22 蔡萬得分析師 【股市得意】', ['蔡萬得']],
  ['林漢偉漲跌停  20260520', undefined],
];

for (const [title, defaults] of cases) {
  console.log(JSON.stringify({
    title: title.slice(0, 50),
    default: defaults,
    from_title: extractAnalystsFromTitle(title),
    merged: resolveAnalystsForVideo(title, defaults),
  }));
}
