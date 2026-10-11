/**
 * Tradução dos filtros do /chat/find (sintaxe uazapi) para condições Prisma.
 * Segurança: apenas campos em whitelist são aceitos e os valores viram parâmetros
 * do Prisma — não existe concatenação de SQL, logo não há SQL injection possível.
 */

type Cond = Record<string, unknown>;

export const STRING_FIELDS: Record<string, string> = {
  wa_chatid: 'chatid',
  wa_contactName: 'contactName',
  wa_name: 'pushName',
  name: 'name',
  wa_notes: 'notes',
  lead_assignedAttendant_id: 'leadAssignedAttendantId',
  lead_status: 'leadStatus',
  lead_name: 'leadName',
  lead_email: 'leadEmail',
};

export const BOOL_FIELDS: Record<string, string> = {
  wa_archived: 'archived',
  wa_isBlocked: 'blocked',
  wa_isGroup: 'isGroup',
  wa_isGroup_admin: 'isGroupAdmin',
  wa_isGroup_announce: 'isGroupAnnounce',
  wa_isGroup_member: 'isGroupMember',
  wa_isPinned: 'pinned',
  lead_isTicketOpen: 'leadIsTicketOpen',
};

export const ARRAY_FIELDS: Record<string, string> = {
  wa_label: 'labels',
  lead_tags: 'leadTags',
  lead_tag: 'leadTags',
};

export const SORT_FIELDS: Record<string, string> = {
  wa_lastMsgTimestamp: 'lastMsgTimestamp',
  name: 'name',
  wa_name: 'pushName',
  wa_contactName: 'contactName',
  wa_unreadCount: 'unreadCount',
  lead_kanbanOrder: 'leadKanbanOrder',
  lead_status: 'leadStatus',
  created: 'createdAt',
  updated: 'updatedAt',
};

export function stringCondition(field: string, raw: string): Cond {
  const ops: Array<[string, (v: string) => Cond]> = [
    ['!=', (v) => ({ NOT: { [field]: { equals: v } } })],
    ['!~', (v) => ({ NOT: { [field]: { contains: v, mode: 'insensitive' } } })],
    ['>=', (v) => ({ [field]: { gte: v } })],
    ['<=', (v) => ({ [field]: { lte: v } })],
    ['=', (v) => ({ [field]: { equals: v } })],
    ['~', (v) => ({ [field]: { contains: v, mode: 'insensitive' } })],
    ['>', (v) => ({ [field]: { gt: v } })],
    ['<', (v) => ({ [field]: { lt: v } })],
  ];
  for (const [prefix, build] of ops) if (raw.startsWith(prefix)) return build(raw.slice(prefix.length));
  return { [field]: { contains: raw, mode: 'insensitive' } };
}

export function buildChatWhere(body: Record<string, unknown>): { conditions: Cond[]; operator: 'AND' | 'OR' } {
  const conditions: Cond[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === '') continue;
    if (key in STRING_FIELDS) {
      conditions.push(stringCondition(STRING_FIELDS[key]!, String(value).slice(0, 200)));
    } else if (key in BOOL_FIELDS) {
      conditions.push({ [BOOL_FIELDS[key]!]: value === true || value === 'true' });
    } else if (key in ARRAY_FIELDS) {
      const v = String(value).replace(/^[=~]/, '').slice(0, 100);
      conditions.push({ [ARRAY_FIELDS[key]!]: { has: v } });
    } else if (key === 'wa_fastid') {
      conditions.push({ chatid: { equals: String(value).split(':').pop() } });
    }
  }
  return { conditions, operator: body.operator === 'OR' ? 'OR' : 'AND' };
}

export function buildSort(sort: unknown): Record<string, 'asc' | 'desc'> {
  if (typeof sort !== 'string' || !sort) return { lastMsgTimestamp: 'desc' };
  const dir = sort.startsWith('-') ? 'desc' : 'asc';
  const field = SORT_FIELDS[sort.replace(/^[+-]/, '')];
  return field ? { [field]: dir } : { lastMsgTimestamp: 'desc' };
}
