import { useEffect, useState } from 'react'
import type { SearchResult } from '../../../shared/phase4'
import { timestamp } from './session'
export function HighlightedSnippet({text}:{text:string}) {
 return <>{text.split(/(\x01[^\x02]*\x02)/g).map((part,i)=>part.startsWith('\x01') ?
   <mark key={i}>{part.slice(1,-1)}</mark> : part)}</>
}
export function MeetingSearch({open}:{open:(result:SearchResult)=>void}) {
 const [query,setQuery]=useState(''), [results,setResults]=useState<SearchResult[]>([]), [error,setError]=useState(''), [loading,setLoading]=useState(false)
 useEffect(()=>{
   let active=true
   const load=async()=>{
     setLoading(true)
     try {const rows=await window.vinxaMeetings.search(query);if(active){setResults(rows);setError('')}}
     catch {if(active)setError('Search could not be completed.')}
     finally {if(active)setLoading(false)}
   }
   const timer=setTimeout(()=>void load(),200)
   const off=window.vinxaMeetings.onChange(()=>void load())
   return()=>{active=false;clearTimeout(timer);off()}
 },[query])
 return <section className="panel meeting-search">
 <label>Search saved meetings<input type="search" aria-label="Search saved meetings" value={query} maxLength={500} onChange={e=>setQuery(e.target.value)} placeholder="Words or prefixes from transcripts and notes" /></label>
 {loading&&<p role="status">Searching…</p>}
 {error&&<p role="alert">{error}</p>}
 {query.trim()&&!loading&&!error&&!results.length&&<p>No matching passages.</p>}
 <ul className="search-results">{results.map(result=><li key={result.meetingId+result.category+result.targetId}>
 <button onClick={()=>open(result)}><strong>{result.title}</strong> · {result.category} {result.speaker&&'· '+result.speaker} {result.atMs!==null&&'· '+timestamp(result.atMs)}
 <span className="search-snippet"><HighlightedSnippet text={result.snippet}/></span></button>
 </li>)}</ul>
 {results.length===200&&<p>Showing the first 200 matches. Add words to narrow the search.</p>}
 </section>
}
