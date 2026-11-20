// Close other menus when one opens, and close all on an outside click or Escape.
(function(){
  var menus=[].slice.call(document.querySelectorAll('nav details'));
  menus.forEach(function(d){d.addEventListener('toggle',function(){if(d.open){menus.forEach(function(o){if(o!==d)o.open=false;});}});});
  document.addEventListener('click',function(e){menus.forEach(function(d){if(!d.contains(e.target))d.open=false;});});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){menus.forEach(function(d){d.open=false;});}});
})();
