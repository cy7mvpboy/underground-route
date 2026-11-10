[out:json][timeout:240];
// 한국 안의 철도역·정류장(railway=station|halt, public_transport=station 중 철도류)
area["ISO3166-1"="KR"][admin_level=2]->.kr;
(
  nwr(area.kr)[railway~"^(station|halt)$"];
  nwr(area.kr)[public_transport=station][train=yes];
  nwr(area.kr)[public_transport=station][subway=yes];
  nwr(area.kr)[public_transport=station][light_rail=yes];
  nwr(area.kr)[public_transport=station][monorail=yes];
);
out center tags;
