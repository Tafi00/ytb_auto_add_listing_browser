from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


class ProtobufDecodeError(ValueError):
    pass


@dataclass
class WireField:
    number: int
    wire_type: int
    value: int | bytes


def decode_varint(data: bytes, offset: int = 0) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(data) and shift < 70:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
    raise ProtobufDecodeError("Varint không hợp lệ")


def encode_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("Chỉ hỗ trợ varint không dấu")
    output = bytearray()
    while value > 0x7F:
        output.append((value & 0x7F) | 0x80)
        value >>= 7
    output.append(value)
    return bytes(output)


def parse_message(data: bytes) -> list[WireField]:
    fields: list[WireField] = []
    offset = 0
    while offset < len(data):
        key, offset = decode_varint(data, offset)
        number, wire_type = key >> 3, key & 7
        if number <= 0:
            raise ProtobufDecodeError("Field number không hợp lệ")
        if wire_type == 0:
            value, offset = decode_varint(data, offset)
        elif wire_type == 1:
            end = offset + 8
            if end > len(data):
                raise ProtobufDecodeError("Fixed64 bị cắt")
            value, offset = data[offset:end], end
        elif wire_type == 2:
            size, offset = decode_varint(data, offset)
            end = offset + size
            if end > len(data):
                raise ProtobufDecodeError("Length-delimited field bị cắt")
            value, offset = data[offset:end], end
        elif wire_type == 5:
            end = offset + 4
            if end > len(data):
                raise ProtobufDecodeError("Fixed32 bị cắt")
            value, offset = data[offset:end], end
        else:
            raise ProtobufDecodeError(f"Wire type {wire_type} chưa được hỗ trợ")
        fields.append(WireField(number, wire_type, value))
    return fields


def serialize_message(fields: Iterable[WireField]) -> bytes:
    output = bytearray()
    for field in fields:
        output.extend(encode_varint((field.number << 3) | field.wire_type))
        if field.wire_type == 0:
            output.extend(encode_varint(int(field.value)))
        elif field.wire_type in (1, 5):
            output.extend(bytes(field.value))
        elif field.wire_type == 2:
            raw = bytes(field.value)
            output.extend(encode_varint(len(raw)))
            output.extend(raw)
        else:
            raise ValueError(f"Wire type {field.wire_type} chưa được hỗ trợ")
    return bytes(output)


def try_parse_message(data: bytes) -> list[WireField] | None:
    try:
        fields = parse_message(data)
    except (ProtobufDecodeError, TypeError):
        return None
    return fields if fields else None


def replace_bytes_at_path(
    data: bytes,
    path: tuple[int, ...],
    replacement: bytes,
    occurrence: int = 0,
) -> bytes:
    if not path:
        return replacement
    fields = parse_message(data)
    seen = 0
    changed = False
    for field in fields:
        if field.number != path[0] or field.wire_type != 2:
            continue
        if seen != occurrence:
            seen += 1
            continue
        if len(path) == 1:
            field.value = replacement
        else:
            field.value = replace_bytes_at_path(bytes(field.value), path[1:], replacement)
        changed = True
        break
    if not changed:
        raise KeyError("Không tìm thấy protobuf path " + ".".join(map(str, path)))
    return serialize_message(fields)


def nested_length_values(data: bytes, path: tuple[int, ...]) -> list[bytes]:
    values = [data]
    for number in path:
        next_values = []
        for value in values:
            for field in parse_message(value):
                if field.number == number and field.wire_type == 2:
                    next_values.append(bytes(field.value))
        values = next_values
        if not values:
            break
    return values


def iter_length_fields(
    data: bytes,
    prefix: tuple[int, ...] = (),
    max_depth: int = 12,
):
    if max_depth < 0:
        return
    try:
        fields = parse_message(data)
    except ProtobufDecodeError:
        return
    occurrences: dict[int, int] = {}
    for field in fields:
        index = occurrences.get(field.number, 0)
        occurrences[field.number] = index + 1
        if field.wire_type != 2:
            continue
        raw = bytes(field.value)
        path = prefix + (field.number,)
        yield path, index, raw
        if try_parse_message(raw):
            yield from iter_length_fields(raw, path, max_depth - 1)


def find_utf8_values(data: bytes):
    for path, occurrence, raw in iter_length_fields(data):
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if text and all(char.isprintable() or char in "\r\n\t" for char in text):
            yield path, occurrence, text


def messages_containing(data: bytes, needle: bytes):
    """Yield the smallest valid nested messages containing *needle*."""
    matches = []
    for path, occurrence, raw in iter_length_fields(data):
        if needle not in raw or not try_parse_message(raw):
            continue
        matches.append((path, occurrence, raw))
    if not matches:
        return []
    deepest = max(len(item[0]) for item in matches)
    return [item for item in matches if len(item[0]) == deepest]
