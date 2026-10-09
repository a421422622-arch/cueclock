import { openConfiguration, useStore } from '../store.ts';
import { configName } from '../lib/configName.ts';
import { Icon } from './Icon.tsx';

/** 顶栏左侧唯一入口，打开包含配置文件与软件设置两页的配置管理。 */
export function ProjectMenu({ file }: { file: string | null }) {
  const open = useStore((s) => s.settingsOpen);
  return (
    <div className="projmenu">
      <button className="projbtn" onClick={() => openConfiguration('files')}
        title={`配置管理 · 当前配置：${configName(file)}`} aria-label="配置管理" aria-haspopup="dialog" aria-expanded={open}>
        <Icon name="folder" size={15} />
      </button>
    </div>
  );
}
