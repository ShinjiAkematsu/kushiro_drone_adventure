(() => {
    'use strict';

    const SPOTS = window.KUSHIRO_SPOTS;

    const state = {
      lat:42.99072, lng:144.38210, altitude:72, heading:180, speed:0,
      visited:new Set(), target:null, autopilot:false, paused:false, started:false,
      pitch:62, zoom:16.4, orbit:0, cameraMode:'follow', timeMode:1, mapMode:0,
      lastTime:performance.now(), lastCheck:0, audio:true
    };
    const keys = Object.create(null);
    const $ = id => document.getElementById(id);
    let map, droneMarker, mapReady = false, modalWasPaused = false;

    try { localStorage.removeItem('kushiro-skylines-save'); } catch (_) {}
    state.visited=new Set();

    function initMap() {
      if (!window.maplibregl) {
        $('loadStatus').textContent='地図ライブラリを読み込めませんでした。通信を確認してください。';
        $('startBtn').disabled=false; $('startBtn').textContent='地図を再試行';
        return;
      }
      map = new maplibregl.Map({
        container:'map', style:'https://tiles.openfreemap.org/styles/liberty',
        center:[state.lng,state.lat], zoom:state.zoom, pitch:state.pitch, bearing:state.heading,
        antialias:true, attributionControl:true, maxPitch:85, renderWorldCopies:false,
        dragPan:false, dragRotate:false, scrollZoom:false, doubleClickZoom:false, touchZoomRotate:false,
        keyboard:false
      });
      map.on('load', onMapLoad);
      map.on('error', e => {
        if (!mapReady) $('loadStatus').textContent='地図データに接続中… 通信状況によって少し時間がかかります';
      });
      setTimeout(() => {
        if (!mapReady) {
          $('startBtn').disabled=false; $('startBtn').textContent='地図を再試行';
          $('loadStatus').textContent='読み込みに時間がかかっています。接続を確認して再試行できます。';
        }
      }, 12000);
    }

    function onMapLoad() {
      mapReady=true;
      addAerialTexture();
      add3DBuildings();
      addDrone();
      addSpotLayers();
      renderSpotList(); updateProgress(); updateHUD(true);
      $('startBtn').disabled=false;
      $('startBtn').textContent=state.visited.size ? '飛行を再開する' : 'フライトを開始する';
      $('loadStatus').textContent='MAP READY / AERIAL PHOTO + 3D CITY LOADED';
    }

    function addAerialTexture() {
      try {
        map.addSource('gsi-aerial', {
          type:'raster',
          tiles:['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
          tileSize:256, minzoom:2, maxzoom:18,
          attribution:'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">航空写真：国土地理院</a>'
        });
        const layers=map.getStyle().layers || [];
        const firstRoad=layers.find(l => l.type==='line' && l['source-layer']==='transportation');
        const firstLabel=layers.find(l => l.type==='symbol');
        map.addLayer({
          id:'gsi-aerial-texture', type:'raster', source:'gsi-aerial', minzoom:0,
          paint:{'raster-opacity':.96,'raster-saturation':.12,'raster-contrast':.08,'raster-fade-duration':280}
        }, (firstRoad || firstLabel || {}).id);
      } catch (e) { console.warn('Aerial texture fallback:',e); }
    }

    function add3DBuildings() {
      try {
        const layers=map.getStyle().layers || [];
        const building=layers.find(l => l['source-layer']==='building');
        if (!building) return;
        const label=layers.find(l => l.type==='symbol' && l.layout && l.layout['text-field']);
        map.addLayer({
          id:'kushiro-3d-buildings', type:'fill-extrusion', source:building.source, 'source-layer':'building', minzoom:14,
          paint:{
            'fill-extrusion-color':['interpolate',['linear'],['zoom'],14.2,'#b4c0ba',17,'#e5ded0'],
            'fill-extrusion-height':['interpolate',['linear'],['zoom'],14,0,15.2,['coalesce',['get','render_height'],['get','height'],9]],
            'fill-extrusion-base':['coalesce',['get','render_min_height'],['get','min_height'],0],
            'fill-extrusion-opacity':.79,
            'fill-extrusion-vertical-gradient':true
          }
        }, label && label.id);
      } catch (e) { console.warn('3D layer fallback:',e); }
    }

    function addDrone() {
      const el=document.createElement('div'); el.className='drone-wrap';
      el.innerHTML='<svg class="drone-body" viewBox="0 0 64 64" fill="none"><circle cx="13" cy="13" r="8" stroke="#edf7f5" stroke-width="2"/><circle cx="51" cy="13" r="8" stroke="#edf7f5" stroke-width="2"/><circle cx="13" cy="51" r="8" stroke="#edf7f5" stroke-width="2"/><circle cx="51" cy="51" r="8" stroke="#edf7f5" stroke-width="2"/><path d="M19 19l9 9m17-9-9 9M19 45l9-9m17 9-9-9" stroke="#edf7f5" stroke-width="3" stroke-linecap="round"/><path d="M32 22l9 17-9-4-9 4 9-17z" fill="#8cf1d2"/><circle cx="32" cy="32" r="4" fill="#09211b"/></svg>';
      droneMarker=new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([state.lng,state.lat]).addTo(map);
    }

    function createSpotPinImage(fill) {
      const canvas=document.createElement('canvas'); canvas.width=64; canvas.height=88;
      const ctx=canvas.getContext('2d');
      ctx.beginPath(); ctx.moveTo(32,83);
      ctx.bezierCurveTo(27,70,8,54,8,33); ctx.bezierCurveTo(8,15,18,5,32,5);
      ctx.bezierCurveTo(46,5,56,15,56,33); ctx.bezierCurveTo(56,54,37,70,32,83); ctx.closePath();
      ctx.fillStyle=fill; ctx.fill(); ctx.lineWidth=5; ctx.strokeStyle='rgba(255,255,255,.94)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(32,31,8,0,Math.PI*2); ctx.fillStyle='#4b2a12'; ctx.fill();
      ctx.beginPath(); ctx.arc(29,28,2.5,0,Math.PI*2); ctx.fillStyle='rgba(255,255,255,.82)'; ctx.fill();
      return ctx.getImageData(0,0,64,88);
    }

    function spotGeoJSON() {
      return {type:'FeatureCollection',features:SPOTS.map((s,i)=>({
        type:'Feature',geometry:{type:'Point',coordinates:[s.lng,s.lat]},
        properties:{index:i,name:s.name,en:s.en,visited:state.visited.has(i)?1:0,target:state.target===i?1:0}
      }))};
    }

    function updateSpotSource() {
      const source=map && map.getSource('kushiro-spots'); if(source) source.setData(spotGeoJSON());
    }

    function addSpotLayers() {
      map.addImage('spot-pin-orange',createSpotPinImage('#ff9d45'),{pixelRatio:2});
      map.addImage('spot-pin-visited',createSpotPinImage('#53dfb8'),{pixelRatio:2});
      map.addImage('spot-pin-target',createSpotPinImage('#ffd066'),{pixelRatio:2});
      map.addSource('kushiro-spots',{type:'geojson',data:spotGeoJSON()});
      map.addLayer({
        id:'kushiro-spot-halos',type:'circle',source:'kushiro-spots',
        paint:{
          'circle-radius':['interpolate',['linear'],['zoom'],10,5,14,12,18,18],
          'circle-color':['case',['==',['get','visited'],1],'#53dfb8',['==',['get','target'],1],'#ffd066','#ff9d45'],
          'circle-opacity':.2,'circle-stroke-width':1,'circle-stroke-color':'rgba(255,255,255,.72)',
          'circle-pitch-alignment':'map'
        }
      });
      map.addLayer({
        id:'kushiro-spot-pins',type:'symbol',source:'kushiro-spots',
        layout:{
          'icon-image':['case',['==',['get','visited'],1],'spot-pin-visited',['==',['get','target'],1],'spot-pin-target','spot-pin-orange'],
          'icon-anchor':'bottom','icon-allow-overlap':true,'icon-ignore-placement':true,'icon-size':1,
          'icon-pitch-alignment':'viewport','icon-rotation-alignment':'viewport'
        }
      });
      const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:[0,-47]});
      map.on('mouseenter','kushiro-spot-pins',e=>{
        map.getCanvas().style.cursor='pointer'; const f=e.features && e.features[0]; if(!f)return;
        popup.setLngLat(f.geometry.coordinates).setHTML('<strong>'+f.properties.name+'</strong><br><small>'+f.properties.en+'</small>').addTo(map);
      });
      map.on('mouseleave','kushiro-spot-pins',()=>{map.getCanvas().style.cursor='';popup.remove();});
      map.on('click','kushiro-spot-pins',e=>{const f=e.features&&e.features[0];if(f)setTarget(Number(f.properties.index));});
    }

    function renderSpotList() {
      $('spotList').innerHTML=SPOTS.map((s,i)=>
        '<div class="spot-row '+(state.visited.has(i)?'visited':'')+'" data-spot="'+i+'"><div class="spot-index">'+(state.visited.has(i)?'✓':String(i+1).padStart(2,'0'))+'</div><div class="spot-copy"><strong>'+s.name+'</strong><small>'+s.en+'</small></div><span class="spot-arrow">›</span></div>'
      ).join('');
      document.querySelectorAll('.spot-row').forEach(el=>el.addEventListener('click',()=>{
        setTarget(+el.dataset.spot);
        setMobileMenu(false);
      }));
    }

    function startGame() {
      if (!mapReady) { try { map && map.remove(); } catch(_){} initMap(); return; }
      state.started=true; state.paused=false; document.body.classList.add('playing');
      $('pauseBtn').textContent='Ⅱ';
      if(state.audio) playBGM(false);
      toast(state.visited.size ? '飛行記録を読み込みました' : '矢印キーで飛行　WASDでカメラ操作');
      if (!state.visited.size) setTimeout(()=>setTarget(1),700);
      state.lastTime=performance.now(); requestAnimationFrame(tick);
    }

    function tick(now) {
      if (!state.started) return;
      const dt=Math.min((now-state.lastTime)/1000,.05); state.lastTime=now;
      if (!state.paused && !document.hidden) updateFlight(dt,now);
      updateCamera(dt); updateHUD(false);
      requestAnimationFrame(tick);
    }

    function updateFlight(dt,now) {
      const screenForward=(keys.up?1:0)-(keys.down?1:0);
      const screenRight=(keys.right?1:0)-(keys.left?1:0)+(keys.e?1:0)-(keys.q?1:0);
      const cameraVertical=(keys.w?1:0)-(keys.s?1:0);
      const cameraHorizontal=(keys.d?1:0)-(keys.a?1:0);
      const manualMove=screenForward||screenRight;
      if (manualMove && state.autopilot) toggleAutopilot(false);

      let cameraBearing=state.cameraMode==='top'?0:normalize(state.heading+state.orbit);
      if(cameraVertical || cameraHorizontal) {
        state.cameraMode='custom';
        state.pitch=Math.max(15,Math.min(82,state.pitch+cameraVertical*38*dt));
        cameraBearing=normalize(cameraBearing+cameraHorizontal*62*dt);
        state.orbit=normalizeSigned(cameraBearing-state.heading);
        document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
        syncSliders();
      }

      let moving=false, moveBearing=state.heading, targetSpeed=0, autopilotDistance=0;

      if (state.autopilot && state.target!==null) {
        const s=SPOTS[state.target], dist=haversine(state.lat,state.lng,s.lat,s.lng);
        autopilotDistance=dist;
        const desired=bearingTo(state.lat,state.lng,s.lat,s.lng);
        state.heading=rotateToward(state.heading,desired,Math.min(80*dt,Math.max(18,Math.abs(angleDiff(state.heading,desired))*.8)*dt));
        moveBearing=state.heading;
        moving=dist>Math.max(48,s.radius*.55);
        if (dist<Math.max(48,s.radius*.55)) toggleAutopilot(false);
      } else if(manualMove) {
        const directionOffset=Math.atan2(screenRight,screenForward)*180/Math.PI;
        moveBearing=normalize(cameraBearing+directionOffset);
        state.heading=moveBearing;
        if(state.cameraMode!=='top') state.orbit=normalizeSigned(cameraBearing-state.heading);
        if(Math.abs(normalizeSigned(directionOffset))>1 && state.cameraMode!=='top') {
          state.cameraMode='custom';
          document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
        }
        moving=true;
      }

      const boost=keys.shift?2:1;
      if (moving) {
        if(state.autopilot) {
          targetSpeed=(autopilotDistance>40000?520:autopilotDistance>15000?340:autopilotDistance>5000?210:autopilotDistance>1500?145:110)*boost;
          const cruiseAltitude=autopilotDistance>15000?520:autopilotDistance>5000?320:state.altitude;
          if(state.altitude<cruiseAltitude) state.altitude=Math.min(cruiseAltitude,state.altitude+55*dt);
        } else targetSpeed=78*boost;
      }
      state.speed += (targetSpeed-state.speed)*Math.min(1,dt*4);
      const moveSpeed=moving?Math.max(16,state.speed):state.speed;
      if (moving) {
        const rad=moveBearing*Math.PI/180;
        const east=Math.sin(rad)*moveSpeed*dt;
        const north=Math.cos(rad)*moveSpeed*dt;
        state.lat += north/111320;
        state.lng += east/(111320*Math.cos(state.lat*Math.PI/180));
      }
      if (keys.r) state.altitude=Math.min(800,state.altitude+72*dt);
      if (keys.f) state.altitude=Math.max(12,state.altitude-72*dt);

      if (state.cameraMode==='cinematic' && !cameraVertical && !cameraHorizontal) state.orbit=normalizeSigned(state.orbit+5*dt);
      if (now-state.lastCheck>260) { state.lastCheck=now; checkDiscovery(); save(); }
    }

    function updateCamera() {
      if (!mapReady) return;
      droneMarker && droneMarker.setLngLat([state.lng,state.lat]);
      const bearing=state.cameraMode==='top'?0:normalize(state.heading+state.orbit);
      const altitudeZoom=Math.log2(Math.max(12,state.altitude)/72)*.72;
      const visualZoom=Math.max(11,Math.min(19,state.zoom-altitudeZoom));
      map.jumpTo({center:[state.lng,state.lat], zoom:visualZoom, pitch:state.pitch, bearing});
      const body=document.querySelector('.drone-body'); if(body) body.style.transform='rotate('+normalizeSigned(state.heading-bearing)+'deg)';
    }

    function updateHUD(force) {
      $('altitudeValue').textContent=Math.round(state.altitude);
      $('speedValue').textContent=Math.round(state.speed*3.6);
      $('latValue').textContent=state.lat.toFixed(5)+'°N'; $('lngValue').textContent=state.lng.toFixed(5)+'°E';
      $('compassNeedle').style.transform='rotate('+state.heading+'deg)';
      const nearest=nearestSpot();
      const s=SPOTS[nearest.index];
      if (nearest.distance<s.radius*1.25) {
        $('locationName').textContent=s.name+' 上空'; $('locationSub').textContent=s.subtitle; $('zoneDistance').textContent='スポット上空';
      } else {
        const dir=directionLabel(bearingTo(s.lat,s.lng,state.lat,state.lng));
        $('locationName').textContent='釧路市街 '+dir+'エリア'; $('locationSub').textContent=s.name+'から'+dir+'へ '+formatDistance(nearest.distance)+'。'; $('zoneDistance').textContent='最寄り '+s.name;
      }
      if(state.target!==null) {
        const t=SPOTS[state.target], d=haversine(state.lat,state.lng,t.lat,t.lng);
        $('targetDistance').textContent=formatDistance(d); $('targetName').textContent=t.name+' へ向かう';
      }
    }

    function nearestSpot() {
      let best={index:0,distance:Infinity};
      SPOTS.forEach((s,i)=>{const d=haversine(state.lat,state.lng,s.lat,s.lng);if(d<best.distance)best={index:i,distance:d};}); return best;
    }

    function checkDiscovery() {
      SPOTS.forEach((s,i)=>{
        if(!state.visited.has(i) && haversine(state.lat,state.lng,s.lat,s.lng)<=s.radius) discover(i);
      });
    }

    function discover(i) {
      state.visited.add(i); updateSpotSource(); renderSpotList(); updateProgress(); save();
      playClearSfx();
      modalWasPaused=state.paused; state.paused=true;
      $('discoveryTitle').textContent=SPOTS[i].name; $('discoveryEn').textContent=SPOTS[i].en; $('discoveryStory').textContent=SPOTS[i].story;
      $('discoveryModal').dataset.index=i; $('discoveryModal').classList.add('open');
      if (state.visited.size===SPOTS.length) {
        $('discoveryStory').textContent=SPOTS[i].story+'　'+SPOTS.length+'の記憶がそろいました。霧の向こうに、あなた自身の釧路の風景が完成しました。';
        $('nextTargetBtn').style.display='none';
      } else $('nextTargetBtn').style.display='inline-block';
    }

    function playClearSfx() {
      const sfx=$('clearSfx');
      sfx.currentTime=0; sfx.volume=.9;
      const result=sfx.play();
      if(result && result.catch) result.catch(()=>{});
    }

    function updateProgress() {
      const n=state.visited.size; $('progressText').textContent=n+' / '+SPOTS.length; $('progressFill').style.width=(n/SPOTS.length*100)+'%';
      $('missionText').textContent=n===SPOTS.length?'KUSHIRO FLIGHT COMPLETE':'霧の記憶を集める';
    }

    function setTarget(i) {
      state.target=i; state.autopilot=false; $('targetCard').classList.add('active'); $('autopilotBtn').classList.remove('active');
      $('autopilotBtn').textContent='P　オートパイロット'; updateSpotSource(); updateHUD(true); toast(SPOTS[i].name+'を目的地に設定');
    }
    function clearTarget() { state.target=null; state.autopilot=false; updateSpotSource(); $('targetCard').classList.remove('active'); }
    function toggleAutopilot(value=!state.autopilot) {
      if(state.target===null) { const next=nextUnvisited(); if(next===null)return; setTarget(next); }
      state.autopilot=value;
      $('autopilotBtn').classList.toggle('active',value); $('autopilotBtn').textContent=value?'■　自動操縦を停止':'P　オートパイロット';
      if(value){state.paused=false;$('pauseBtn').textContent='Ⅱ';toast('オートパイロットを開始');}
    }
    function nextUnvisited(after=-1) {
      for(let k=1;k<=SPOTS.length;k++){const i=(after+k)%SPOTS.length;if(!state.visited.has(i))return i;} return null;
    }

    function closeDiscovery(setNext=false) {
      const current=+$('discoveryModal').dataset.index; $('discoveryModal').classList.remove('open'); state.paused=modalWasPaused;
      if(setNext){const n=nextUnvisited(current);if(n!==null)setTarget(n);}
    }

    function setCameraMode(mode) {
      state.cameraMode=mode; document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
      if(mode==='follow'){state.pitch=62;state.zoom=16.4;state.orbit=0;}
      if(mode==='top'){state.pitch=15;state.zoom=13.2;state.orbit=0;}
      if(mode==='cinematic'){state.pitch=72;state.zoom=15.4;state.orbit=28;}
      syncSliders();
    }
    function syncSliders(){
      $('pitchSlider').value=state.pitch;$('zoomSlider').value=state.zoom;$('orbitSlider').value=normalizeSigned(state.orbit);
      $('pitchOut').value=Math.round(state.pitch)+'°';$('zoomOut').value=(+state.zoom).toFixed(1);$('orbitOut').value=Math.round(normalizeSigned(state.orbit))+'°';
    }

    function cycleTime() {
      const modes=[['day','☀ 昼'],['golden','◐ 薄暮'],['night','☾ 夜']]; state.timeMode=(state.timeMode+1)%modes.length;
      document.body.dataset.time=modes[state.timeMode][0]; $('timeBtn').textContent=modes[state.timeMode][1];
    }

    function cycleBasemap() {
      const modes=[
        {label:'航空写真', opacity:.96, toast:'本物の航空写真＋3D表示'},
        {label:'写真＋地図', opacity:.68, toast:'航空写真と街路地図を重ねて表示'},
        {label:'街路地図', opacity:0, toast:'街路地図＋3D表示'}
      ];
      state.mapMode=(state.mapMode+1)%modes.length;
      const selected=modes[state.mapMode];
      if(map && map.getLayer('gsi-aerial-texture')) map.setPaintProperty('gsi-aerial-texture','raster-opacity',selected.opacity);
      const label=$('basemapBtn').querySelector('strong'); if(label) label.textContent=selected.label;
      $('basemapQuickBtn').textContent=state.mapMode===0?'▧':state.mapMode===1?'◫':'◇';
      toast(selected.toast);
    }

    function toast(text) {
      const el=document.createElement('div');el.className='toast';el.textContent=text;$('toastHost').appendChild(el);
      setTimeout(()=>el.classList.add('out'),2400);setTimeout(()=>el.remove(),2800);
    }

    function save() {
      // 飛行状態は保存せず、再起動時は必ず釧路駅から開始する。
    }

    function playBGM(showToast=true) {
      const bgm=$('bgm');
      bgm.volume=.58;
      const result=bgm.play();
      if(result && result.catch) result.catch(()=>{
        state.audio=false; updateAudioButton();
        if(showToast) toast('BGMを再生できませんでした');
      });
      updateAudioButton();
      if(showToast) toast('BGM「Breeze Through Kushiro」 ON');
    }

    function updateAudioButton() {
      $('soundBtn').classList.toggle('active',state.audio);
      $('soundBtn').textContent=state.audio?'♫':'♪';
    }

    function initAudio() {
      state.audio=!state.audio;
      if(state.audio) playBGM(true);
      else { $('bgm').pause(); updateAudioButton(); toast('BGM OFF'); }
    }

    function togglePause() { state.paused=!state.paused;$('pauseBtn').textContent=state.paused?'▶':'Ⅱ';toast(state.paused?'フライトを一時停止':'フライトを再開'); }

    function haversine(lat1,lng1,lat2,lng2){const R=6371000,p1=lat1*Math.PI/180,p2=lat2*Math.PI/180,dp=(lat2-lat1)*Math.PI/180,dl=(lng2-lng1)*Math.PI/180;const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
    function bearingTo(lat1,lng1,lat2,lng2){const p1=lat1*Math.PI/180,p2=lat2*Math.PI/180,dl=(lng2-lng1)*Math.PI/180;return normalize(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI);}
    function angleDiff(a,b){return normalizeSigned(b-a);}
    function rotateToward(cur,target,amount){const d=angleDiff(cur,target);return normalize(cur+Math.sign(d)*Math.min(Math.abs(d),amount));}
    function normalize(v){return((v%360)+360)%360;}
    function normalizeSigned(v){v=normalize(v);return v>180?v-360:v;}
    function formatDistance(m){return m<1000?Math.round(m)+' m':(m/1000).toFixed(1)+' km';}
    function directionLabel(b){return ['北','北東','東','南東','南','南西','西','北西'][Math.round(normalize(b)/45)%8];}

    function controlKey(e) {
      const controls={
        ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',
        KeyW:'w',KeyA:'a',KeyS:'s',KeyD:'d',KeyQ:'q',KeyE:'e',KeyR:'r',KeyF:'f',KeyP:'p',
        ShiftLeft:'shift',ShiftRight:'shift',Space:'space'
      };
      return controls[e.code] || null;
    }

    document.addEventListener('keydown',e=>{
      const k=controlKey(e); if(!k)return; e.preventDefault();
      if(k==='p'&&!e.repeat)toggleAutopilot(); else if(k==='space'&&!e.repeat)togglePause(); else keys[k]=true;
    });
    document.addEventListener('keyup',e=>{const k=controlKey(e);if(k){e.preventDefault();keys[k]=false;}});
    window.addEventListener('blur',()=>Object.keys(keys).forEach(k=>keys[k]=false));
    document.addEventListener('visibilitychange',()=>{if(document.hidden)Object.keys(keys).forEach(k=>keys[k]=false);});

    document.querySelectorAll('.touch-key').forEach(btn=>{
      const k=btn.dataset.key;
      const on=e=>{e.preventDefault();keys[k]=true;}; const off=e=>{e.preventDefault();keys[k]=false;};
      btn.addEventListener('pointerdown',on);btn.addEventListener('pointerup',off);btn.addEventListener('pointercancel',off);btn.addEventListener('pointerleave',off);
    });
    document.querySelectorAll('.panel-head').forEach(btn=>btn.addEventListener('click',()=>btn.parentElement.classList.toggle('collapsed')));
    function setMobileMenu(open) {
      $('flightMenu').classList.toggle('mobile-open',open);
      $('mobileMenuBtn').classList.toggle('active',open);
      $('mobileMenuBtn').setAttribute('aria-expanded',String(open));
      $('mobileMenuBtn').setAttribute('aria-label',open?'設定とスポットを閉じる':'設定とスポットを開く');
    }
    $('mobileMenuBtn').addEventListener('click',()=>setMobileMenu(!$('flightMenu').classList.contains('mobile-open')));
    let mobileLayout=window.matchMedia('(max-width:650px)').matches;
    if(mobileLayout) {
      document.querySelectorAll('.right-stack .panel').forEach(panel=>panel.classList.add('collapsed'));
    }
    window.addEventListener('resize',()=>{
      const nextMobile=window.innerWidth<=650;
      if(nextMobile&&!mobileLayout) document.querySelectorAll('.right-stack .panel').forEach(panel=>panel.classList.add('collapsed'));
      if(!nextMobile) setMobileMenu(false);
      mobileLayout=nextMobile;
    });
    $('map').addEventListener('pointerdown',()=>{if(mobileLayout)setMobileMenu(false);});
    document.querySelectorAll('.mode-btn').forEach(btn=>btn.addEventListener('click',()=>setCameraMode(btn.dataset.mode)));

    $('pitchSlider').addEventListener('input',e=>{state.pitch=+e.target.value;state.cameraMode='custom';document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));$('pitchOut').value=Math.round(state.pitch)+'°';});
    $('zoomSlider').addEventListener('input',e=>{state.zoom=+e.target.value;$('zoomOut').value=state.zoom.toFixed(1);});
    $('orbitSlider').addEventListener('input',e=>{state.orbit=+e.target.value;$('orbitOut').value=Math.round(state.orbit)+'°';});
    $('map').addEventListener('wheel',e=>{if(!state.started)return;e.preventDefault();state.zoom=Math.max(11.5,Math.min(18.5,state.zoom+(e.deltaY<0?.12:-.12)));syncSliders();},{passive:false});
    $('map').addEventListener('contextmenu',e=>e.preventDefault());

    $('startBtn').addEventListener('click',startGame);$('autopilotBtn').addEventListener('click',()=>toggleAutopilot());$('cancelTargetBtn').addEventListener('click',clearTarget);
    $('soundBtn').addEventListener('click',initAudio);$('pauseBtn').addEventListener('click',togglePause);$('timeBtn').addEventListener('click',cycleTime);
    $('basemapBtn').addEventListener('click',cycleBasemap);$('basemapQuickBtn').addEventListener('click',cycleBasemap);
    $('resetViewBtn').addEventListener('click',()=>setCameraMode('follow'));
    $('closeDiscoveryBtn').addEventListener('click',()=>closeDiscovery(false));$('nextTargetBtn').addEventListener('click',()=>closeDiscovery(true));

    syncSliders(); initMap();
  })();
