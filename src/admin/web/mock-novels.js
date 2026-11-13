/**
 * Mock routes for the novel library (写小说). Registered from mock.js through
 * install(registry); see mock.js for the registry contract.
 *
 * One sample book is paused with a ticket on the shelf. POST api/novels creates
 * a drafting book that turns ready after a few seconds.
 */
const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString()
const DAY = 86400e3

export function install(registry) {
  const { add } = registry
  const settings = {
    enabled: true,
    models: { planner: null, writer: null, reviewer: null, extractor: null },
    chapterChars: [2500, 3500],
    maxRevisions: 2,
    minScore: 80,
    dailyUsd: 2.5,
    arcUsd: 5,
    bookUsd: 50,
    maxActiveBooks: 1,
    extraBanned: [],
  }
  const books = [{
    id: 'demo-book',
    title: '九转戒灵录',
    genre: 'xianxia',
    genreLabel: '仙侠',
    phase: 'paused',
    lastChapter: 3,
    chars: 7420,
    costUsd: 1.82,
    flagged: 1,
    currentTicket: 'T-novel-03',
    nextArc: { n: 2, title: '宗门大比', chapters: 30, status: 'planned' },
    createdAt: iso(3 * DAY),
    updatedAt: iso(60e3),
    idea: '废材少年得到一枚会吞噬功法的古戒',
    chapterChars: [2500, 3500],
    plan: {
      volumes: [{ n: 1, title: '初入山门', goal: '立足，拜入宗门' }],
      arcs: [
        { n: 1, volume: 1, title: '废材入门', template: '开局', goal: '拜师', chapters: 12, startCh: 1, status: 'done', summary: '林川拜入外门。' },
        { n: 2, volume: 1, title: '宗门大比', template: '比武', goal: '扬名', chapters: 30, startCh: 13, status: 'planned' },
      ],
    },
    bible: {
      premise: '废材少年林川得到一枚古戒，戒中灵魂可吞噬他人功法，一路逆袭。',
      sellingPoints: ['吞噬功法', '逆袭打脸'],
      goldenFinger: { name: '噬功古戒', rules: ['吞噬功法后可复刻一招'], limits: ['每日一次'], growth: ['吞噬层数越高越强'] },
    },
    chapters: [
      { n: 1, arc: 1, title: '废材', chars: 2480, status: 'committed', costUsd: 0.5, score: 88, committedAt: iso(3 * DAY) },
      { n: 2, arc: 1, title: '古戒', chars: 2510, status: 'committed', costUsd: 0.6, score: 84, committedAt: iso(2 * DAY) },
      { n: 3, arc: 1, title: '入门', chars: 2430, status: 'flagged', costUsd: 0.72, score: 74, committedAt: iso(DAY) },
    ],
    tickets: [],
  }]

  const listShape = (book) => ({
    id: book.id,
    title: book.title,
    genre: book.genre,
    genreLabel: book.genreLabel,
    phase: book.phase,
    lastChapter: book.lastChapter,
    chars: book.chars,
    costUsd: book.costUsd,
    flagged: book.flagged,
    currentTicket: book.currentTicket,
    nextArc: book.nextArc,
    error: book.error,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  })
  const detailShape = (book) => ({
    book: listShape(book),
    idea: book.idea,
    chapterChars: book.chapterChars,
    plan: book.plan,
    bible: book.bible,
    chapters: book.chapters,
    tickets: book.tickets,
  })
  const findBook = (params) => books.find((book) => book.id === params.id)

  add('GET', '/api/settings/novel', () => ({ ...settings, models: { ...settings.models } }))
  add('PUT', '/api/settings/novel', ({ body }) => {
    Object.assign(settings, body ?? {})
    return { ok: true, changed: Object.keys(body ?? {}), note: '小说设置已保存' }
  })

  add('GET', '/api/novels', () => ({ items: books.map(listShape) }))

  add('POST', '/api/novels', ({ body }) => {
    const id = `book-${Date.now().toString(36)}`
    const [min, max] = Array.isArray(body?.chapterChars) ? body.chapterChars : [2500, 3500]
    const xuanhuan = body?.genre === 'xuanhuan'
    books.unshift({
      id,
      title: String(body?.title || body?.idea || '新书').slice(0, 12),
      genre: xuanhuan ? 'xuanhuan' : 'xianxia',
      genreLabel: xuanhuan ? '玄幻' : '仙侠',
      phase: 'drafting',
      lastChapter: 0,
      chars: 0,
      costUsd: 0,
      flagged: 0,
      createdAt: iso(),
      updatedAt: iso(),
      idea: String(body?.idea ?? ''),
      chapterChars: [min, max],
      plan: { volumes: [], arcs: [] },
      bible: {},
      chapters: [],
      tickets: [],
    })
    setTimeout(() => {
      const book = books.find((item) => item.id === id)
      if (!book) return
      book.phase = 'ready'
      book.nextArc = { n: 1, title: '开篇', chapters: 12, status: 'planned' }
      book.plan = {
        volumes: [{ n: 1, title: '第一卷', goal: '立足' }],
        arcs: [{ n: 1, volume: 1, title: '开篇', chapters: 12, status: 'planned', goal: '入门' }],
      }
      book.updatedAt = iso()
    }, 4000)
    return { id }
  })

  add('GET', '/api/novels/:id', ({ params, fail }) => {
    const book = findBook(params)
    if (!book) return fail(404, 'not_found', '找不到这本书。')
    return detailShape(book)
  })

  add('DELETE', '/api/novels/:id', ({ params, fail }) => {
    const index = books.findIndex((book) => book.id === params.id)
    if (index < 0) return fail(404, 'not_found', '找不到这本书。')
    books.splice(index, 1)
    return { ok: true }
  })

  add('POST', '/api/novels/:id/arcs', ({ params, fail }) => {
    const book = findBook(params)
    if (!book) return fail(404, 'not_found', '找不到这本书。')
    if (book.phase === 'writing') return fail(409, 'busy', '这本书正在写一弧。')
    if (book.phase !== 'ready' && book.phase !== 'paused') return fail(409, 'not_ready', '这本书还不能开写。')
    book.phase = 'writing'
    book.currentTicket = 'T-novel-04'
    return { ok: true, ticketId: 'T-novel-04', arc: book.nextArc }
  })

  add('GET', '/api/novels/:id/canon', ({ params, fail }) => {
    if (!findBook(params)) return fail(404, 'not_found', '找不到这本书。')
    return {
      characters: [{ name: '林川', role: '主角', realm: '炼气一层' }, { name: '云曦', role: '师姐', realm: '筑基初期' }],
      foreshadow: [{ text: '古戒的来历', status: '未回收' }],
      items: [{ name: '噬功古戒', owner: '林川' }],
    }
  })

  add('GET', '/api/novels/:id/work', ({ params }) => {
    const book = findBook(params)
    if (!book || book.phase !== 'writing') return { n: null }
    return { n: book.lastChapter + 1, contract: { beats: ['主角拜入外门', '遇见师姐'] }, review: { score: 86 } }
  })

  add('GET', '/api/novels/:id/chapters/:n', ({ params, fail }) => {
    const book = findBook(params)
    const chapter = book?.chapters.find((item) => String(item.n) === params.n)
    if (!chapter) return fail(404, 'not_found', '找不到这一章。')
    const paragraphs = [1, 2, 3].map((index) => `这是第 ${chapter.n} 章第 ${index} 段的${chapter.edited ? '修改后' : '演示'}正文，林川握着古戒，心里默念功法口诀。`)
    return {
      n: chapter.n,
      text: [`# ${chapter.title}`, '', ...paragraphs].join('\n'),
      summary: '演示小结',
      row: { n: chapter.n, status: chapter.status ?? 'committed', score: chapter.score ?? null },
      notes: ['审稿：人物动机清楚（86 分）', '伏笔：古戒来历保持未回收'],
      ...(chapter.edit ? { edit: chapter.edit } : {}),
      lastChapter: book.lastChapter,
    }
  })

  // Editing one chapter: the mock finishes the edit two seconds after it is asked for.
  add('POST', '/api/novels/:id/chapters/:n/edit', ({ params, body, fail }) => {
    const book = findBook(params)
    const chapter = book?.chapters.find((item) => String(item.n) === params.n)
    if (!chapter) return fail(404, 'not_found', '找不到这一章。')
    chapter.edit = { id: 'e_mock', n: chapter.n, status: 'running', note: String(body?.note ?? ''), costUsd: 0 }
    setTimeout(() => { chapter.edit.status = 'done'; chapter.edited = true }, 2000)
    return { ok: true, edit: chapter.edit }
  })
  add('POST', '/api/novels/:id/chapters/:n/undo', ({ params, fail }) => {
    const chapter = findBook(params)?.chapters.find((item) => String(item.n) === params.n)
    if (!chapter?.edit || chapter.edit.status !== 'done') return fail(409, 'conflict', '这一章没有可以撤销的修改。')
    chapter.edit.status = 'undone'
    chapter.edited = false
    return { ok: true, edit: chapter.edit }
  })
  add('POST', '/api/novels/:id/chapters/:n/read', ({ params, fail }) => {
    const book = findBook(params)
    const chapter = book?.chapters.find((item) => String(item.n) === params.n)
    if (!chapter) return fail(404, 'not_found', '找不到这一章。')
    if (chapter.status === 'flagged') { chapter.status = 'committed'; book.flagged = Math.max(0, (book.flagged ?? 1) - 1) }
    return { ok: true }
  })
}
