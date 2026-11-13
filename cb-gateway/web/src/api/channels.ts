import { api } from './client';

export interface ChannelAppearance {
  id: string;
  label: string;
  idPrefix: string;
  letter: string;
  icon: string | null;
}

export function getChannels(): Promise<{ channels: ChannelAppearance[] }> {
  return api.get<{ channels: ChannelAppearance[] }>('/api/channels');
}
