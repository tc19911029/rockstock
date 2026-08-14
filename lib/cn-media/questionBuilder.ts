import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import {
  loadCnMediaSources,
  loadCnMediaTranscript,
  loadCnMediaVideos,
} from './storage';
import { collectCnStockCandidates, loadCnStockMaster } from './stockMaster';
import { loadCnMacro, loadCnStockBundles } from './stockDataLoader';
import type { CnMediaQuestionPayload } from './types';

export const CN_MEDIA_QUESTION_DIR = path.join(tmpdir(), 'rockstock-cn-media');

const INSTRUCTIONS = `你是中國 A 股分析師。通讀每支節目逐字稿，提取節目實際提到的 A 股、態度、理由與原話證據，並做跨節目共識。

硬規則：
1. 不可只看標題；每支 transcript_text 都要讀。
2. 不可把節目沒提過的股票列入。代號與正式名稱以 stock_candidates 為準。
3. high_consensus 僅限至少 2 個不同 source_id 同向提及；同一媒體的不同節目仍須保留來源數，並在 market_view 說明來源集中度。
4. 官方媒體內容不等於投資建議；主持人、嘉賓、新聞轉述要區分。
5. 技術、資金、財務、新聞評分須引用 stock_data_bundles；缺資料的維度一律 50 分並標 missing。
6. 輸出繁體中文，股票正式名稱保留中國簡體原名。`;

export async function buildCnMediaQuestion(date: string): Promise<CnMediaQuestionPayload> {
  const [videos, sources, master] = await Promise.all([
    loadCnMediaVideos(date), loadCnMediaSources(), loadCnStockMaster(),
  ]);
  const transcripts = await Promise.all(videos.map(video => loadCnMediaTranscript(date, video.video_id)));
  const questionVideos = videos.flatMap((video, index) => {
    const transcript = transcripts[index];
    if (!transcript || transcript.status !== 'available') return [];
    return [{
      ...video,
      transcript_quality_score: transcript.quality_score,
      transcript_char_count: transcript.char_count,
      transcript_cue_count: transcript.cue_count,
      transcript_text: transcript.text,
    }];
  });
  const candidates = collectCnStockCandidates(
    questionVideos.flatMap(video => [video.title, video.transcript_text]), master,
  );
  const [bundles, macro] = await Promise.all([
    loadCnStockBundles(candidates.slice(0, 20)),
    loadCnMacro(),
  ]);

  return {
    schema_version: 1,
    market: 'CN_STOCK',
    date,
    generated_at: new Date().toISOString(),
    instructions: INSTRUCTIONS,
    output_path: path.join(process.cwd(), 'data', 'cn-media', 'analysis', `${date}.json`),
    videos: questionVideos,
    source_transcript_availability: sources.filter(source => source.active).map(source => ({
      source_id: source.source_id,
      display_name: source.display_name,
      source_tier: source.source_tier,
      videos_found: videos.filter(video => video.source_id === source.source_id).length,
      transcript_available: questionVideos.filter(video => video.source_id === source.source_id).length,
    })),
    stock_candidates: candidates,
    stock_data_bundles: bundles,
    macro,
  };
}
export async function writeCnMediaQuestion(payload: CnMediaQuestionPayload): Promise<string> {
  await fs.mkdir(CN_MEDIA_QUESTION_DIR, { recursive: true });
  const target = path.join(CN_MEDIA_QUESTION_DIR, `${payload.date}-question.json`);
  await atomicFsPut(target, JSON.stringify(payload, null, 2));
  return target;
}
