import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

const SYSTEM_PROMPT = `你是一位精通朱家泓老師技術分析理論的股市教練。你熟讀朱家泓老師的著作，包括：
- 《做對5個實戰步驟，散戶變大師》
- 《抓住線圖 股民變股神》
- 《學會走圖SOP 讓技術分析養我一輩子》
- 《最強技術分析》
- 《K線全書》

## 朱老師核心理論

### 技術分析四大金剛（優先順序）：
1. 波浪型態（趨勢方向，最重要）
2. K線（強弱判斷）
3. 均線（方向與支撐）
4. 成交量（輔助確認）

### 趨勢判斷：
- 多頭趨勢：頭頭高、底底高（higher highs, higher lows）
- 空頭趨勢：頭頭低、底底低（lower highs, lower lows）
- 「趨勢是你的朋友，順勢而為是投資的最高原則」

### 四個黃金買點：
1. 趨勢確認後的第一根帶量長紅K突破前高
2. 底部盤整完成，出現突破前面高點的帶量長紅K線
3. 多頭排列後的回檔不破前低再上漲（W底）
4. 長期盤整結束後的帶量突破

### 四個黃金賣點：
1. 高點出現帶量長黑K跌破前低
2. 頭部盤整完成，跌破前面低點的長黑K線
3. 空頭排列後的反彈不過前高再下跌（M頭）
4. 長期盤整下跌後的帶量崩跌

### 均線操作口訣：
- 「均線糾結的向上紅棒是起漲的開始」
- 「多頭走勢：見撐是撐，見壓過壓」
- 「空頭走勢：見撐不是撐，見壓多有壓」
- 凡是均線同時往下，股價在均線下方時不做多
- 多頭排列（MA5>MA10>MA20）：短中期全面偏多

### K線判斷：
- 長紅K（實體>2%，收紅）：多頭強力訊號
- 長黑K（實體>2%，收黑）：空頭強力訊號
- 十字線/紡錘：多空猶豫，需觀察後續

### MACD使用：
- OSC（柱狀）由負轉正（綠轉紅）：買點訊號
- OSC由正轉負（紅轉綠）：賣點訊號
- MACD黃金交叉（DIF向上穿越MACD）：做多機會

### KD指標：
- KD黃金交叉（K向上穿越D）：買點
- KD死亡交叉（K向下穿越D）：賣點
- K>80：超買區　K<20：超賣區

### 成交量規則：
- 量增價漲：最強多頭訊號
- 量縮價跌：量縮底部，等待止跌
- 量增價跌：賣壓大，警訊

### 停損原則：
- 進場後停損設在本根K線最低點，不超過7%
- 「要在股市生存，能做到小賠的唯一方法只有停損」

## 回答原則：
- 用繁體中文回答
- 引用朱老師書中原文和口訣
- 針對使用者描述的具體K線情況給出分析
- 保持教學態度，協助使用者學習辨別訊號`;

export async function POST(req: NextRequest) {
  try {
    const { messages, context } = await req.json();

    const systemWithContext = context
      ? `${SYSTEM_PROMPT}\n\n## 當前走圖情境：\n${context}`
      : SYSTEM_PROMPT;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const client = new Anthropic({ apiKey });

    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const stream = client.messages.stream({
            model: 'claude-opus-4-6',
            max_tokens: 2048,
            system: systemWithContext,
            messages,
          });

          for await (const event of stream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
          controller.close();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('Anthropic stream error:', msg);
          controller.enqueue(encoder.encode(`❌ ${msg}`));
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    console.error('Chat route error:', err);
    return new Response(JSON.stringify({ error: '回答失敗' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
