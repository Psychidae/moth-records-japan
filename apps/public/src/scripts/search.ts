import { z } from 'zod';
import { createSearchIndex,searchNames,type SearchIndex,type SearchResult } from '../../../../packages/public-data/src/search.ts';

let indexPromise:Promise<SearchIndex>|undefined;
async function getIndex():Promise<SearchIndex> {
  if(indexPromise) return indexPromise;
  indexPromise=(async()=>{
    const path=z.string().regex(/^\/data\/\d{4}\.\d{2}\.\d+\/names\.json$/).parse(document.querySelector<HTMLFormElement>('form[data-names-url]')?.dataset.namesUrl);
    const response=await fetch(path,{credentials:'omit',redirect:'error'});
    if(!response.ok) throw new Error('Name data unavailable');
    const data:unknown=await response.json();return createSearchIndex(data);
  })();
  try{return await indexPromise;}catch(error){indexPromise=undefined;throw error;}
}
// No names request on ordinary page load: focus or a submitted search starts it.
for(const input of document.querySelectorAll<HTMLInputElement>('input[name="q"]')) input.addEventListener('focus',()=>{void getIndex().catch(()=>undefined);});

const form=document.querySelector<HTMLFormElement>('#search-form');
const input=form?.querySelector<HTMLInputElement>('input[name="q"]');
const list=document.querySelector<HTMLOListElement>('#search-results');
const status=document.querySelector<HTMLParagraphElement>('#search-status');
const pagination=document.querySelector<HTMLElement>('#search-pagination');
const previous=document.querySelector<HTMLButtonElement>('#search-previous');
const next=document.querySelector<HTMLButtonElement>('#search-next');
const pageStatus=document.querySelector<HTMLElement>('#search-page-status');
if(form && input && list && status && pagination && previous && next && pageStatus) {
  const pageSize=50;
  let results:SearchResult[]=[];let currentQuery='';let currentPage=1;let generation=0;
  const pageFromUrl=()=>{const parsed=z.coerce.number().int().min(1).max(10000).safeParse(new URL(location.href).searchParams.get('page')??'1');return parsed.success?parsed.data:1;};
  function display(page:number,updateUrl:boolean) {
    if(!list || !status || !pagination || !previous || !next || !pageStatus) return;
    const totalPages=Math.max(1,Math.ceil(results.length/pageSize));currentPage=Math.max(1,Math.min(totalPages,page));
    const fragment=document.createDocumentFragment();
    for(const result of results.slice((currentPage-1)*pageSize,currentPage*pageSize)) {
      const item=document.createElement('li');
      const heading=document.createElement('p');heading.className='result-name';
      const link=document.createElement('a');link.href=`/species/${result.taxon}/`;link.textContent=result.nameJa??result.scientificName;heading.append(link);
      const scientific=document.createElement('p');scientific.className='result-scientific';scientific.textContent=result.scientificName;
      const code=document.createElement('p');code.className='small';code.textContent=`分類群 ${result.taxon}`;
      item.append(heading,scientific,code);
      if(result.viaAlias) {const guide=document.createElement('p');guide.className='alias-guide';guide.textContent=`「${result.matchedName}」で一致。現在の学名は ${result.scientificName}。`;item.append(guide);}
      if(result.collisionCount>1) {const collision=document.createElement('p');collision.className='small';collision.textContent=`同学名の登録 ${result.collisionCount}件 · コードごとに表示`;item.append(collision);}
      fragment.append(item);
    }
    list.replaceChildren(fragment);
    status.textContent=currentQuery ? `「${currentQuery}」: ${results.length.toLocaleString('ja-JP')}件` : '学名・和名・別名を入力してください。';
    if(currentQuery && !results.length) status.textContent+=' 別の表記でも検索できます。';
    pagination.hidden=results.length<=pageSize;previous.disabled=currentPage===1;next.disabled=currentPage===totalPages;pageStatus.textContent=`${currentPage} / ${totalPages}ページ`;
    if(updateUrl) {const url=new URL(location.href);url.searchParams.delete('q');url.searchParams.delete('page');if(currentQuery)url.searchParams.set('q',currentQuery);if(currentPage>1)url.searchParams.set('page',String(currentPage));history.replaceState(null,'',url);}
  }
  async function run(query:string,page=1,updateUrl=true) {
    if(!list || !status) return;const token=++generation;
    const parsed=z.string().max(160).safeParse(query);
    if(!parsed.success){status.textContent='検索語は160文字以内で入力してください。';list.replaceChildren();return;}
    currentQuery=parsed.data.trim();
    if(!currentQuery){results=[];display(1,updateUrl);return;}
    status.textContent='名称データを読み込んでいます。';
    try{const index=await getIndex();if(token!==generation)return;results=searchNames(index,currentQuery);display(page,updateUrl);}
    catch{if(token===generation){status.textContent='名称データを取得できませんでした。検索ボタンで再試行してください。';list.replaceChildren();pagination?.setAttribute('hidden','');}}
  }
  let timer:ReturnType<typeof setTimeout>|undefined;
  form.addEventListener('submit',event=>{event.preventDefault();if(timer)clearTimeout(timer);void run(input.value);});
  input.addEventListener('input',event=>{if(timer)clearTimeout(timer);if(event instanceof InputEvent && event.isComposing)return;timer=setTimeout(()=>{void run(input.value);},200);});
  previous.addEventListener('click',()=>display(currentPage-1,true));next.addEventListener('click',()=>display(currentPage+1,true));
  addEventListener('popstate',()=>{input.value=new URL(location.href).searchParams.get('q')??'';void run(input.value,pageFromUrl(),false);});
  input.value=new URL(location.href).searchParams.get('q')??'';
  if(input.value) void run(input.value,pageFromUrl(),false);
}
