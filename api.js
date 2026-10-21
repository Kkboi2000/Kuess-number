// The only file that talks to Supabase.
// Every move is a call to a kuess_* database function; the database is the referee.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_KEY.startsWith('YOUR-');

const sb = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Each device is an anonymous player. The session survives refreshes.
export async function signIn() {
  if (!sb) throw new Error('setup');
  const { data } = await sb.auth.getSession();
  if (data.session) return;
  const { error } = await sb.auth.signInAnonymously();
  if (error) throw new Error(/anonymous/i.test(error.message) ? 'anon' : error.message);
}

async function call(fn, args = {}) {
  const { data, error } = await sb.rpc(`kuess_${fn}`, args);
  if (error) throw new Error(error.message || 'generic');
  return data;
}

export const api = {
  myRoom:      ()                => call('my_room'),
  state:       (room)            => call('state', { p_room: room }),
  createRoom:  (name)            => call('create_room', { p_name: name }),
  joinRoom:    (code, name)      => call('join_room', { p_code: code, p_name: name }),
  leave:       (room)            => call('leave', { p_room: room }),
  settings:    (room, patch)     => call('update_settings', { p_room: room, p_settings: patch }),
  setOrder:    (room, ids)       => call('set_order', { p_room: room, p_order: ids }),
  setNumber:   (room, id, value) => call('set_number', { p_room: room, p_player: id, p_value: value }),
  start:       (room)            => call('start', { p_room: room }),
  guess:       (room, value)     => call('guess', { p_room: room, p_value: value }),
  pass:        (room)            => call('pass', { p_room: room }),
  end:         (room)            => call('end', { p_room: room }),
  rematch:     (room)            => call('rematch', { p_room: room }),
};

// Calls onChange whenever the room's version moves (and once on connect).
// Returns a function that stops listening.
export function watchRoom(roomId, onChange) {
  const channel = sb
    .channel(`kuess-room-${roomId}`)
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'kuess', table: 'rooms', filter: `id=eq.${roomId}` },
        () => onChange())
    .subscribe((status) => { if (status === 'SUBSCRIBED') onChange(); });
  return () => sb.removeChannel(channel);
}
