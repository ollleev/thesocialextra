export const APPEARANCES=Object.freeze({notice:{label:'Crème',paper:'#f7f4ef'},sage:{label:'Sauge',paper:'#edf3ee'},paper:{label:'Blanc',paper:'#fffdf9'}});
const KEY='thesocialextra:appearance:v1';
export function createAppearance({document,storage}) {
  const choices=[...document.querySelectorAll('#appearance-menu button[data-appearance]')],menu=document.querySelector('#appearance-menu');
  function apply(value,{persist=false}={}) {
    const theme=Object.hasOwn(APPEARANCES,value)?value:'notice';
    document.documentElement.dataset.appearance=theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',APPEARANCES[theme].paper);
    for(const choice of choices)choice.setAttribute('aria-pressed',String(choice.dataset.appearance===theme));
    if(persist){try{storage?.setItem(KEY,theme);}catch{/* The selection still works for this visit. */}}
    return theme;
  }
  let saved;try{saved=storage?.getItem(KEY);}catch{/* Storage is optional. */}apply(saved);
  for(const choice of choices)choice.addEventListener('click',()=>apply(choice.dataset.appearance,{persist:true}));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu?.open){menu.open=false;menu.querySelector('summary').focus();}});
  document.addEventListener('pointerdown',event=>{if(menu?.open&&!menu.contains(event.target))menu.open=false;});
  return {apply};
}
if(typeof document!=='undefined') {
  let storage;try{storage=globalThis.localStorage;}catch{/* Browsing remains available. */}
  createAppearance({document,storage});
}
