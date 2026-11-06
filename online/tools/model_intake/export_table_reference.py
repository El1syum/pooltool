"""Export the current Pooltool eight-ball geometry for offline cosmetic preparation."""
import json
from pathlib import Path
import pooltool as pt
from pooltool.game.datatypes import GameType

table=pt.Table.from_game_type(GameType.EIGHTBALL)
data={'source':'pt.Table.from_game_type(GameType.EIGHTBALL)', 'width':table.w,'length':table.l,'height':table.height,
      'linear':[{'id':k,'p1':s.p1.tolist(),'p2':s.p2.tolist(),'noseRadius':s.nose_radius} for k,s in table.cushion_segments.linear.items()],
      'circular':[{'id':k,'center':s.center.tolist(),'radius':s.radius} for k,s in table.cushion_segments.circular.items()],
      'pockets':[{'id':k,'center':p.center.tolist(),'radius':p.radius} for k,p in table.pockets.items()]}
path=Path(__file__).with_name('table-reference.json')
path.write_text(json.dumps(data,indent=2)+'\n',encoding='utf8')
print(f'Exported current physics reference: {table.w} x {table.l} m; height {table.height} m')
