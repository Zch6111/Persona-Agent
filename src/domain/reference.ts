export interface SpeechReference {
  id: string;
  characterId: string;
  kind: 'dialogue' | 'voice' | 'story' | 'summary' | 'example';
  title: string;
  source: { id: string; title: string; origin: string; url?: string };
  text?: string;
  turns?: { speaker: string; text: string }[];
  context?: string;
  era?: string;
  relationship?: string;
  tags?: string[];
  anchor: boolean;
}
