/** 朱老師自動觸發統一走通用 skill runner，避免兩份 AppleScript 漂移。 */
import { triggerSkillKeystroke } from './skillAutoTrigger';

export async function triggerZhuKeystroke(): Promise<{ ok: boolean; detail?: string }> {
  return triggerSkillKeystroke('/zhu');
}
