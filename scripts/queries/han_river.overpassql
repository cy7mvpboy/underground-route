[out:json][timeout:120];
// 서울 부근 한강 중심선(waterway=river, name=한강). 철도와 교차하는 곳을 찾는 데 쓴다.
way[waterway=river][name="한강"](37.45,126.60,37.75,127.35);
out geom;
