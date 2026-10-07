/**
 * 校验和 / CRC：HEX 协议和「串口转网络网关」几乎必备。只用 Uint8Array，不依赖 Node，界面里的预览也能直接用。
 * 约定：对「内容字节」（可跳过开头 skip 个字节，如帧头）计算，结果**原始字节**追加在内容后面（ASCII 的结束符在校验和之后）。
 */
export type ChecksumAlgo = 'sum8' | 'sum8-neg' | 'xor8' | 'crc16-modbus' | 'crc16-ccitt' | 'crc16-xmodem';

export interface ChecksumSpec {
  algo: ChecksumAlgo;
  /** 跳过开头的字节数（帧头、地址等不参与计算），默认 0 */
  skip?: number;
}

export const CHECKSUM_ALGOS: { value: ChecksumAlgo; label: string; bytes: number; note: string }[] = [
  { value: 'sum8', label: 'Sum8（字节和，取低 8 位）', bytes: 1, note: '全部字节相加，取低 8 位' },
  { value: 'sum8-neg', label: 'Sum8 取补码（256 − 和）', bytes: 1, note: '使「内容 + 校验」的字节和为 0' },
  { value: 'xor8', label: 'XOR8（异或）', bytes: 1, note: '全部字节逐个异或' },
  { value: 'crc16-modbus', label: 'CRC16-Modbus（低字节在前）', bytes: 2, note: '多项式 0xA001（反射），初值 0xFFFF；Modbus RTU' },
  { value: 'crc16-ccitt', label: 'CRC16-CCITT-FALSE（高字节在前）', bytes: 2, note: '多项式 0x1021，初值 0xFFFF' },
  { value: 'crc16-xmodem', label: 'CRC16-XMODEM（高字节在前）', bytes: 2, note: '多项式 0x1021，初值 0x0000' },
];

export const isChecksumAlgo = (v: unknown): v is ChecksumAlgo => CHECKSUM_ALGOS.some((a) => a.value === v);

function crc16(data: Uint8Array, init: number, poly: number, reflected: boolean): number {
  let crc = init;
  for (const b of data) {
    if (reflected) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1;
    } else {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** 计算要追加的校验字节。skip 超过长度时按空内容算（校验函数不报错，发送内容的合法性由调用方检查）。 */
export function checksumBytes(data: Uint8Array, spec: ChecksumSpec): Uint8Array {
  const body = data.subarray(Math.min(Math.max(0, Math.trunc(spec.skip ?? 0)), data.length));
  switch (spec.algo) {
    case 'sum8': return Uint8Array.of(body.reduce((s, b) => (s + b) & 0xff, 0));
    case 'sum8-neg': return Uint8Array.of((0x100 - body.reduce((s, b) => (s + b) & 0xff, 0)) & 0xff);
    case 'xor8': return Uint8Array.of(body.reduce((s, b) => s ^ b, 0));
    case 'crc16-modbus': { const c = crc16(body, 0xffff, 0xa001, true); return Uint8Array.of(c & 0xff, c >>> 8); }
    case 'crc16-ccitt': { const c = crc16(body, 0xffff, 0x1021, false); return Uint8Array.of(c >>> 8, c & 0xff); }
    case 'crc16-xmodem': { const c = crc16(body, 0x0000, 0x1021, false); return Uint8Array.of(c >>> 8, c & 0xff); }
  }
}
