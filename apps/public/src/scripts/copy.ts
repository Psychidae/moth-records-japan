for(const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-target]')) {
 button.addEventListener('click',()=>{void (async()=>{
  const target=document.getElementById(button.dataset.copyTarget ?? '');const status=button.parentElement?.querySelector<HTMLElement>('[role="status"]');
  if(!target || !status)return;
  try{await navigator.clipboard.writeText(target.textContent?.trim() ?? '');status.textContent='コピーしました';}
  catch{status.textContent='コピーできませんでした。引用文を選択してコピーしてください。';}
 })();});
}
