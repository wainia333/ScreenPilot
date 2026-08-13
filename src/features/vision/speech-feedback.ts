export type VisionSpeechTarget = 'original' | 'translated'

export type VisionSpeechFailure = {
  target: VisionSpeechTarget
  announcement: string
}

export function resolveVisionSpeechFailure(
  sequence: number,
  currentSequence: number,
  target: VisionSpeechTarget,
  announcement: string,
): VisionSpeechFailure | null {
  if (sequence !== currentSequence) return null
  return { target, announcement }
}

export function visionSpeechControlLabel(
  target: VisionSpeechTarget,
  speakingTarget: VisionSpeechTarget | null,
  errorTarget: VisionSpeechTarget | null,
  labels: { speak: string; stop: string; retry: string },
): string {
  if (speakingTarget === target) return labels.stop
  if (errorTarget === target) return labels.retry
  return labels.speak
}
