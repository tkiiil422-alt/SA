/**
 * BookFiles: the per-book directory layout, canon round trips and validation, snapshots and restore, chapters, discards
 * and exports. Every test runs against a fresh temp directory.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookFiles, atomicWrite, pad4 } from '../src/novel/files.ts'
import type { Book, Character, Setup } from '../src/novel/schemas.ts'
import { CANON_FILES, SetupSchema } from '../src/novel/schemas.ts'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-novel-files-'))
  roots.push(dir)
  return dir
}

function makeSetup(): Setup {
  return SetupSchema.parse({
    bible: {
      premise: '少年林默在青云城拜入宗门，一路逆袭。',
      sellingPoints: ['废柴逆袭'],
      protagonistId: 'p1',
      goldenFinger: { name: '青铜古鼎', rules: ['可以炼化灵草'], limits: ['每日一次'], growth: '逐步解锁' },
      style: { pov: '第三人称', rules: ['短句为主'], banned: ['仿佛'] },
      taboos: [],
      compass: { endgame: '飞升', longLines: [] },
    },
    power: {
      realms: [
        { id: 'qi', name: '练气', order: 1, stages: ['初期', '中期'], abilities: [], breakthrough: { requires: [], risk: '' } },
        { id: 'zhuji', name: '筑基', order: 2, stages: ['初期'], abilities: [], breakthrough: { requires: [], risk: '' } },
      ],
      crossRealmMaxGap: 1,
    },
    characters: [
      { id: 'p1', name: '林默', aliases: [], role: 'protagonist', status: 'alive', realm: { id: 'qi', stage: 0 }, anchors: ['坚忍'], relations: [], knows: [], firstCh: 0, lastSeenCh: 0 },
    ],
    world: {
      factions: [],
      locations: [
        { id: 'l1', name: '青云城', region: '东域', note: '' },
        { id: 'l2', name: '黑风谷', region: '东域', note: '' },
      ],
      routes: [{ from: 'l1', to: 'l2', days: 3 }],
    },
    plan: {
      volumes: [{ n: 1, title: '第一卷', goal: '入门' }],
      arcs: [{ n: 1, volume: 1, title: '入门', template: '成长突破', goal: '拜入宗门', chapters: 10, status: 'skeleton' }],
    },
  })
}

function makeBook(id = 'b_test1'): Book {
  return {
    id,
    title: '测试书',
    genre: 'xianxia',
    idea: '废柴少年的逆袭之路',
    phase: 'setup',
    chapterChars: [2000, 4000],
    volumesPlanned: 1,
    chaptersPerVolume: 20,
    lastChapter: 0,
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z',
  }
}

function canonBytes(files: BookFiles): Record<string, string> {
  const out: Record<string, string> = {}
  for (const file of CANON_FILES) out[file] = readFileSync(join(files.dir, 'canon', `${file}.json`), 'utf8')
  return out
}

describe('pad4 and atomicWrite', () => {
  it('pads chapter numbers to four digits', () => {
    expect(pad4(7)).toBe('0007')
    expect(pad4(1234)).toBe('1234')
  })

  it('creates parent directories and leaves no temp file behind', () => {
    const root = tempRoot()
    const target = join(root, 'a', 'b', 'file.txt')
    atomicWrite(target, 'hello')
    expect(readFileSync(target, 'utf8')).toBe('hello')
    expect(readdirSync(join(root, 'a', 'b'))).toEqual(['file.txt'])
  })
})

describe('BookFiles', () => {
  let root: string
  let setup: Setup
  let files: BookFiles

  beforeEach(() => {
    root = tempRoot()
    setup = makeSetup()
    files = BookFiles.create(root, makeBook(), setup)
  })

  it('round-trips the book and every canon file after create', () => {
    expect(files.exists()).toBe(true)
    expect(files.readBook()).toEqual(makeBook())
    const canon = files.readCanon()
    expect(canon.bible).toEqual(setup.bible)
    expect(canon.power).toEqual(setup.power)
    expect(canon.characters).toEqual(setup.characters)
    expect(canon.world).toEqual(setup.world)
    expect(canon.plan).toEqual(setup.plan)
    expect(canon.items).toEqual([])
    expect(canon.foreshadow).toEqual([])
    expect(canon.secrets).toEqual([])
    expect(canon.timeline).toEqual([])
    expect(canon.pacing).toEqual([])
  })

  it('refuses to create over an existing book directory', () => {
    expect(() => BookFiles.create(root, makeBook(), setup)).toThrow(/已存在/)
  })

  it('writes nothing when the canon is invalid, and leaves the old files unchanged', () => {
    const before = canonBytes(files)
    const canon = files.readCanon()
    const bad = { ...canon, bible: { ...canon.bible, premise: '' }, power: { ...canon.power, realms: canon.power.realms.slice(0, 1) } }
    expect(() => files.writeCanon(bad)).toThrow(/不合法/)
    expect(canonBytes(files)).toEqual(before)
  })

  it('restores canon to the snapshot hash after a snapshot, change and restore', () => {
    const sha = files.canonSha()
    files.snapshot(0)
    expect(files.hasSnapshot(0)).toBe(true)

    const canon = files.readCanon()
    const ally: Character = {
      id: 'a1', name: '苏瑶', aliases: [], role: 'ally', status: 'alive', anchors: [],
      relations: [], knows: [], firstCh: 1, lastSeenCh: 1,
    }
    files.writeCanon({ ...canon, characters: [...canon.characters, ally] })
    expect(files.canonSha()).not.toBe(sha)

    files.restore(0)
    expect(files.canonSha()).toBe(sha)
    expect(files.readCanon().characters).toEqual(setup.characters)
  })

  it('throws when restoring a snapshot that does not exist', () => {
    expect(() => files.restore(9)).toThrow(/快照不存在/)
  })

  it('prunes only the snapshots the keep predicate rejects', () => {
    files.snapshot(0)
    files.snapshot(1)
    files.pruneSnapshots(n => n === 0)
    expect(files.hasSnapshot(0)).toBe(true)
    expect(files.hasSnapshot(1)).toBe(false)
  })

  it('discards chapters from n and moves them out of the live directory', () => {
    for (let n = 1; n <= 5; n++) {
      files.writeChapter(n, `# 第${n}章 标题${n}\n\n正文${n}`)
      files.writeSummary(n, { n })
    }
    const moved = files.discardFrom(3, new Date('2026-11-07T01:02:03Z'))
    expect(moved).toBe(3)
    expect(files.chapterNumbers()).toEqual([1, 2])
    expect(files.readSummary(3)).toBeUndefined()
    expect(files.readSummary<{ n: number }>(2)).toEqual({ n: 2 })
    expect(existsSync(join(files.dir, 'chapters', '.discarded', '20261107010203', 'ch-0003.md'))).toBe(true)
  })

  it('rejects book ids that could escape the root', () => {
    for (const bad of ['../evil', 'b_../x', 'b_', `b_${'a'.repeat(33)}`, 'x', 'b_a/../..']) {
      expect(() => new BookFiles(root, bad)).toThrow(/书籍编号/)
    }
  })

  it('rejects work file names that are not plain names', () => {
    expect(() => files.writeWork(1, '../x', 'a')).toThrow(/工作文件名/)
    expect(() => files.writeWork(1, '..', 'a')).toThrow(/工作文件名/)
  })

  it('writes, reads and clears per-chapter work files', () => {
    files.writeWork(1, 'draft.md', '草稿')
    expect(files.readWork(1, 'draft.md')).toBe('草稿')
    files.clearWork(1)
    expect(files.readWork(1, 'draft.md')).toBeUndefined()
  })

  it('lists chapter numbers in ascending order and reads missing chapters as undefined', () => {
    files.writeChapter(3, '第三章')
    files.writeChapter(1, '第一章')
    expect(files.chapterNumbers()).toEqual([1, 3])
    expect(files.readChapter(2)).toBeUndefined()
    expect(files.readChapter(3)).toBe('第三章')
  })

  it('round-trips summaries and views', () => {
    files.writeSummary(1, { text: '摘要' })
    expect(files.readSummary(1)).toEqual({ text: '摘要' })
    files.writeView('outline', '# 大纲')
    expect(readFileSync(join(files.dir, 'views', 'outline.md'), 'utf8')).toBe('# 大纲')
  })

  it('exports a chapter range with each chapter headed by its number and heading title', () => {
    files.writeChapter(1, '# 初入青云\n\n正文1')
    files.writeChapter(2, '# 夜探黑风谷\n\n正文2')
    files.writeChapter(3, '# 不在范围\n\n正文3')
    expect(files.exportText(1, 2)).toBe('第1章 初入青云\n\n正文1\n\n第2章 夜探黑风谷\n\n正文2')
  })
})
